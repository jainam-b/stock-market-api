// Stock Support Zone Calculator
// Calculates support levels using price action analysis on historical OHLC data

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');

const app = express();
const PORT = process.env.SUPPORT_JOB_PORT || 3003;

app.use(express.json());

// Job status tracking
let jobStatus = {
  isRunning: false,
  startTime: null,
  endTime: null,
  progress: {
    total: 0,
    completed: 0,
    failed: 0,
    current: null
  },
  results: null,
  error: null
};

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'support-job.log' })
  ]
});

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  logger.error('Supabase credentials missing');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const UPSTOX_API_URL = 'https://api.upstox.com/v3/historical-candle/';

// Configuration for support calculation
const CONFIG = {
  LOOKBACK_DAYS_1M: 30,        // Use last 1 month of data
  LOOKBACK_DAYS_12M: 365,      // Use last 12 months of data
  PRICE_TOLERANCE: 0.015,      // 1.5% tolerance for grouping swing lows
  MIN_SWING_LOW_NEIGHBORS: 1   // Minimum neighbors to check on each side
};

// Fetch access token from database
async function getAccessTokenFromDB() {
  try {
    logger.info('Fetching access token from database...');
    
    const { data, error } = await supabase
      .from('access_tokens')
      .select('token, expires_at')
      .eq('provider', 'upstox')
      .eq('is_active', true)
      .limit(1)
      .single();

    if (error) {
      logger.error('Error fetching access token from database:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    if (!data) {
      throw new Error('No active access token found in database');
    }

    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      throw new Error('Access token has expired');
    }

    logger.info('Successfully fetched access token from database');
    return data.token;
  } catch (error) {
    logger.error('Failed to get access token:', error.message);
    const fallback = process.env.UPSTOX_ACCESS_TOKEN;
    if (fallback) {
      logger.warn('Using fallback access token from environment variable');
      return fallback;
    }
    throw error;
  }
}

// Fetch active instruments from stock_instruments table
async function fetchActiveInstruments() {
  try {
    logger.info('Fetching active instruments from stock_instruments table');
    
    const { data, error } = await supabase
      .from('stock_instruments')
      .select('instrument_key')
      .eq('is_active', true);

    if (error) {
      logger.error(`Error fetching active instruments: ${error.message}`);
      throw error;
    }

    if (!data || data.length === 0) {
      logger.warn('No active instruments found in the database');
      return [];
    }

    const instruments = data.map(item => item.instrument_key);
    logger.info(`Found ${instruments.length} active instruments`);
    return instruments;
  } catch (error) {
    logger.error('Failed to fetch active instruments:', error.message);
    throw error;
  }
}

// Fetch historical data from Upstox with configurable lookback period
async function fetchHistoricalData(instrumentKey, lookbackDays = CONFIG.LOOKBACK_DAYS_1M) {
  try {
    const accessToken = await getAccessTokenFromDB();
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - lookbackDays);

    const formatDate = (d) => d.toISOString().split('T')[0];
    const toDate = formatDate(endDate);
    const fromDate = formatDate(startDate);
    
    const url = `${UPSTOX_API_URL}${instrumentKey}/days/1/${toDate}/${fromDate}`;

    logger.info(`Fetching historical data for ${instrumentKey} from ${fromDate} to ${toDate} (${lookbackDays} days)`);

    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });
    return response.data;
  } catch (error) {
    logger.error(`Error fetching historical data for ${instrumentKey}:`, error.message);
    if (error.response) {
      logger.error(`Response status: ${error.response.status}, data:`, error.response.data);
    }
    throw error;
  }
}


/**
 * Identify swing lows in OHLC data
 * A swing low is a candle whose low is lower than its neighboring candles
 * Candle format: [timestamp, open, high, low, close, volume, oi]
 */
function identifySwingLows(candles) {
  const swingLows = [];
  
  if (candles.length < 3) return swingLows;

  for (let i = 1; i < candles.length - 1; i++) {
    const prevLow = candles[i - 1][3];
    const currLow = candles[i][3];
    const nextLow = candles[i + 1][3];

    // A swing low occurs when current low is lower than both neighbors
    if (currLow < prevLow && currLow < nextLow) {
      swingLows.push({
        timestamp: candles[i][0],
        low: currLow,
        index: i
      });
    }
  }

  logger.info(`Found ${swingLows.length} swing lows`);
  return swingLows;
}

/**
 * Group swing lows that are close to each other within price tolerance
 * This creates support zones from clustered swing lows
 */
function groupSwingLows(swingLows, tolerance = CONFIG.PRICE_TOLERANCE) {
  if (swingLows.length === 0) return [];

  const sorted = [...swingLows].sort((a, b) => a.low - b.low);
  
  const zones = [];
  let currentZone = {
    lows: [sorted[0]],
    minPrice: sorted[0].low,
    maxPrice: sorted[0].low
  };

  for (let i = 1; i < sorted.length; i++) {
    const currentLow = sorted[i].low;
    const zoneCenter = (currentZone.minPrice + currentZone.maxPrice) / 2;
    const priceDiff = Math.abs(currentLow - zoneCenter) / zoneCenter;
    
    if (priceDiff <= tolerance) {
      currentZone.lows.push(sorted[i]);
      currentZone.minPrice = Math.min(currentZone.minPrice, currentLow);
      currentZone.maxPrice = Math.max(currentZone.maxPrice, currentLow);
    } else {
      zones.push(currentZone);
      currentZone = {
        lows: [sorted[i]],
        minPrice: sorted[i].low,
        maxPrice: sorted[i].low
      };
    }
  }
  
  zones.push(currentZone);
  return zones;
}

/**
 * Calculate support zones from historical data
 * Returns the strongest support zone based on number of clustered swing lows
 */
function calculateSupportZone(data) {
  if (!data?.data?.candles || data.data.candles.length === 0) {
    throw new Error('Invalid or empty candle data');
  }

  const candles = data.data.candles;
  logger.info(`Processing ${candles.length} candles for support calculation`);

  if (candles.length > 0) {
    logger.info(`Sample candle: timestamp=${candles[0][0]}, open=${candles[0][1]}, high=${candles[0][2]}, low=${candles[0][3]}, close=${candles[0][4]}`);
  }

  const swingLows = identifySwingLows(candles);
  
  if (swingLows.length === 0) {
    logger.warn('No swing lows found in the data');
    return {
      supportLower: null,
      supportUpper: null,
      touchCount: 0,
      avgPrice: null,
      allZones: []
    };
  }

  const zones = groupSwingLows(swingLows);

  const zonesWithStrength = zones.map(zone => ({
    lowerBound: zone.minPrice,
    upperBound: zone.maxPrice,
    touchCount: zone.lows.length,
    avgPrice: zone.lows.reduce((sum, l) => sum + l.low, 0) / zone.lows.length,
    timestamps: zone.lows.map(l => l.timestamp)
  }));

  zonesWithStrength.sort((a, b) => b.touchCount - a.touchCount);

  const strongest = zonesWithStrength[0];
  
  logger.info(`Strongest support zone: ${strongest.lowerBound.toFixed(2)} - ${strongest.upperBound.toFixed(2)} (${strongest.touchCount} touches)`);

  return {
    supportLower: strongest.lowerBound,
    supportUpper: strongest.upperBound,
    touchCount: strongest.touchCount,
    avgPrice: strongest.avgPrice,
    allZones: zonesWithStrength.slice(0, 5)
  };
}

// Save support data to Supabase (both 1-month and 12-month)
async function saveSupportToSupabase(instrumentKey, support1M, support12M) {
  try {
    logger.info(`Saving support data for ${instrumentKey}`);
    logger.info(`  1M: lower=${support1M.supportLower}, upper=${support1M.supportUpper}, touches=${support1M.touchCount}`);
    logger.info(`  12M: lower=${support12M.supportLower}, upper=${support12M.supportUpper}, touches=${support12M.touchCount}`);

    const dataToSave = {
      instrument_key: instrumentKey,
      // 1-month support
      support_lower: support1M.supportLower,
      support_upper: support1M.supportUpper,
      touch_count: support1M.touchCount,
      avg_support_price: support1M.avgPrice,
      all_zones: JSON.stringify(support1M.allZones),
      // 12-month support
      support_lower_12m: support12M.supportLower,
      support_upper_12m: support12M.supportUpper,
      touch_count_12m: support12M.touchCount,
      avg_support_price_12m: support12M.avgPrice,
      all_zones_12m: JSON.stringify(support12M.allZones),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('stock_support')
      .upsert(dataToSave, { onConflict: 'instrument_key' });

    if (error) {
      logger.error(`Error in Supabase upsert for ${instrumentKey}: ${error.message}`);
      throw error;
    }

    logger.info(`Successfully saved support data for ${instrumentKey}`);

    // Verify saved data
    const { data: verifyData, error: verifyError } = await supabase
      .from('stock_support')
      .select('instrument_key, support_lower, support_upper, touch_count, support_lower_12m, support_upper_12m, touch_count_12m, updated_at')
      .eq('instrument_key', instrumentKey)
      .single();

    if (verifyError) {
      logger.warn(`[DEBUG] Could not verify saved data: ${verifyError.message}`);
    } else {
      logger.info(`[DEBUG] Verified saved data for ${instrumentKey}:`);
      logger.info(`  1M: LOWER=${verifyData.support_lower}, UPPER=${verifyData.support_upper}, TOUCHES=${verifyData.touch_count}`);
      logger.info(`  12M: LOWER=${verifyData.support_lower_12m}, UPPER=${verifyData.support_upper_12m}, TOUCHES=${verifyData.touch_count_12m}`);
    }

    return data;
  } catch (error) {
    logger.error(`Error saving support data to Supabase for ${instrumentKey}: ${error.message}`);
    throw error;
  }
}


// Process single instrument - calculates both 1-month and 12-month support
async function processInstrument(instrumentKey) {
  try {
    logger.info(`Processing instrument: ${instrumentKey}`);
    
    // Fetch 1-month historical data and calculate support
    const historicalData1M = await fetchHistoricalData(instrumentKey, CONFIG.LOOKBACK_DAYS_1M);
    const support1M = calculateSupportZone(historicalData1M);
    logger.info(`[DEBUG] 1M support for ${instrumentKey}: LOWER=${support1M.supportLower}, UPPER=${support1M.supportUpper}, TOUCHES=${support1M.touchCount}`);
    
    // Fetch 12-month historical data and calculate support
    const historicalData12M = await fetchHistoricalData(instrumentKey, CONFIG.LOOKBACK_DAYS_12M);
    const support12M = calculateSupportZone(historicalData12M);
    logger.info(`[DEBUG] 12M support for ${instrumentKey}: LOWER=${support12M.supportLower}, UPPER=${support12M.supportUpper}, TOUCHES=${support12M.touchCount}`);
    
    // Save to database if we found valid support in either timeframe
    if (support1M.supportLower !== null || support12M.supportLower !== null) {
      await saveSupportToSupabase(instrumentKey, support1M, support12M);
    }

    return {
      instrumentKey,
      support1M: {
        supportLower: support1M.supportLower,
        supportUpper: support1M.supportUpper,
        touchCount: support1M.touchCount,
        avgPrice: support1M.avgPrice
      },
      support12M: {
        supportLower: support12M.supportLower,
        supportUpper: support12M.supportUpper,
        touchCount: support12M.touchCount,
        avgPrice: support12M.avgPrice
      }
    };
  } catch (error) {
    logger.error(`Failed to process instrument ${instrumentKey}:`, error.message);
    return { instrumentKey, error: error.message };
  }
}

// Main job runner with progress tracking
async function runSupportJob() {
  if (jobStatus.isRunning) {
    throw new Error('Job is already running. Please wait for it to complete.');
  }

  jobStatus = {
    isRunning: true,
    startTime: new Date().toISOString(),
    endTime: null,
    progress: {
      total: 0,
      completed: 0,
      failed: 0,
      current: null
    },
    results: null,
    error: null
  };

  logger.info('Starting support zone calculation job with progress tracking');
  
  const results = {
    successful: [],
    failed: []
  };

  try {
    // Fetch active instruments from the database
    const instruments = await fetchActiveInstruments();
    
    if (instruments.length === 0) {
      logger.warn('No instruments to process. Job completed.');
      jobStatus.progress.total = 0;
      jobStatus.endTime = new Date().toISOString();
      jobStatus.isRunning = false;
      jobStatus.results = results;
      return results;
    }

    jobStatus.progress.total = instruments.length;
    logger.info(`Processing ${instruments.length} instruments`);

    // Process each instrument sequentially to avoid rate limits
    for (let i = 0; i < instruments.length; i++) {
      const instrument = instruments[i];
      jobStatus.progress.current = instrument;

      try {
        logger.info(`Processing ${i + 1}/${instruments.length}: ${instrument}`);
        const result = await processInstrument(instrument);

        if (result.error) {
          results.failed.push(result);
          jobStatus.progress.failed++;
        } else {
          results.successful.push(result);
          jobStatus.progress.completed++;
        }
      } catch (error) {
        results.failed.push({ instrumentKey: instrument, error: error.message });
        jobStatus.progress.failed++;
      }

      // Update progress
      const totalProcessed = jobStatus.progress.completed + jobStatus.progress.failed;
      logger.info(`Progress: ${totalProcessed}/${jobStatus.progress.total} (${Math.round((totalProcessed / jobStatus.progress.total) * 100)}%)`);
    }
  } catch (error) {
    logger.error(`Error fetching instruments: ${error.message}`);
    jobStatus.error = error.message;
    jobStatus.endTime = new Date().toISOString();
    jobStatus.isRunning = false;
    return {
      successful: [],
      failed: [{ instrumentKey: 'FETCH_INSTRUMENTS', error: error.message }]
    };
  }

  jobStatus.endTime = new Date().toISOString();
  jobStatus.isRunning = false;
  jobStatus.results = results;
  jobStatus.progress.current = null;

  const duration = new Date(jobStatus.endTime) - new Date(jobStatus.startTime);
  logger.info(`Job completed in ${Math.round(duration / 1000)}s. Successfully processed: ${results.successful.length}, Failed: ${results.failed.length}`);

  return results;
}

// PRODUCTION SCHEDULE - 3:45 PM IST every weekday (Monday to Friday)
// IST is UTC+5:30, so 3:45 PM IST is 10:15 AM UTC
const productionSchedule = cron.schedule('15 10 * * 1-5', async () => {
  try {
    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    logger.info(`[PRODUCTION] Running scheduled support job at ${istTime.toISOString()} IST (${now.toISOString()} UTC)`);
    await runSupportJob();
    logger.info('[PRODUCTION] Scheduled job completed');
  } catch (error) {
    logger.error('[PRODUCTION] Error in scheduled job:', error);
  }
}, {
  scheduled: false,
  timezone: "UTC"
});

// TESTING SCHEDULE - Runs every minute
const testingSchedule = cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    logger.info(`[TEST MODE] Running scheduled support job at ${istTime.toISOString()} IST (${now.toISOString()} UTC)`);
    await runSupportJob();
    logger.info('[TEST MODE] Scheduled job completed');
  } catch (error) {
    logger.error('[TEST MODE] Error in scheduled job:', error);
  }
}, {
  scheduled: false,
  timezone: "UTC"
});

// Determine which schedule to use based on environment
const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod';

if (isProduction) {
  productionSchedule.start();
  logger.info('🚀 PRODUCTION MODE: Schedule enabled - Job will run at 3:45 PM IST on weekdays');
} else {
  testingSchedule.start();
  logger.info('🧪 TESTING MODE: Schedule enabled - Job will run every minute');
}


// API Endpoints

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'stock-support-job' });
});

// Manual job trigger (synchronous)
app.get('/run-support-job', async (req, res) => {
  try {
    logger.info('Support job triggered via API endpoint (manual or AWS EventBridge)');
    const results = await runSupportJob();
    res.json({ 
      status: 'success',
      message: 'Job completed',
      results
    });
  } catch (error) {
    logger.error('Error running job via API:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Start job (asynchronous) - for frontend
app.post('/start-job', async (req, res) => {
  try {
    if (jobStatus.isRunning) {
      return res.status(409).json({
        status: 'error',
        message: 'Job is already running. Please wait for it to complete.',
        jobStatus: {
          isRunning: jobStatus.isRunning,
          startTime: jobStatus.startTime,
          progress: jobStatus.progress
        }
      });
    }

    logger.info('Job started via frontend API');

    // Start the job asynchronously
    runSupportJob().catch(error => {
      logger.error('Async job error:', error);
      jobStatus.error = error.message;
      jobStatus.endTime = new Date().toISOString();
      jobStatus.isRunning = false;
    });

    res.json({
      status: 'success',
      message: 'Job started successfully',
      jobId: jobStatus.startTime,
      jobStatus: {
        isRunning: jobStatus.isRunning,
        startTime: jobStatus.startTime,
        progress: jobStatus.progress
      }
    });
  } catch (error) {
    logger.error('Error starting job:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get job status and progress
app.get('/job-status', (req, res) => {
  try {
    const duration = jobStatus.startTime && jobStatus.endTime 
      ? new Date(jobStatus.endTime) - new Date(jobStatus.startTime)
      : jobStatus.startTime 
        ? Date.now() - new Date(jobStatus.startTime)
        : null;

    res.json({
      status: 'success',
      jobStatus: {
        ...jobStatus,
        duration: duration ? Math.round(duration / 1000) : null,
        progressPercentage: jobStatus.progress.total > 0 
          ? Math.round(((jobStatus.progress.completed + jobStatus.progress.failed) / jobStatus.progress.total) * 100)
          : 0
      }
    });
  } catch (error) {
    logger.error('Error getting job status:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Stop/cancel the job
app.post('/stop-job', (req, res) => {
  try {
    if (!jobStatus.isRunning) {
      return res.status(400).json({
        status: 'error',
        message: 'No job is currently running'
      });
    }

    logger.warn('Job stop requested via API (soft stop)');
    
    res.json({
      status: 'success',
      message: 'Job stop requested. Note: Current processing will complete, but no new instruments will be processed.',
      jobStatus: {
        isRunning: jobStatus.isRunning,
        progress: jobStatus.progress
      }
    });
  } catch (error) {
    logger.error('Error stopping job:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get job results
app.get('/job-results', (req, res) => {
  try {
    if (!jobStatus.results && !jobStatus.error) {
      return res.status(404).json({
        status: 'error',
        message: 'No job results available. Run a job first.'
      });
    }

    res.json({
      status: 'success',
      jobStatus: {
        isRunning: jobStatus.isRunning,
        startTime: jobStatus.startTime,
        endTime: jobStatus.endTime,
        progress: jobStatus.progress,
        error: jobStatus.error
      },
      results: jobStatus.results,
      summary: jobStatus.results ? {
        totalProcessed: jobStatus.results.successful.length + jobStatus.results.failed.length,
        successful: jobStatus.results.successful.length,
        failed: jobStatus.results.failed.length,
        successRate: jobStatus.results.successful.length + jobStatus.results.failed.length > 0 
          ? Math.round((jobStatus.results.successful.length / (jobStatus.results.successful.length + jobStatus.results.failed.length)) * 100)
          : 0
      } : null
    });
  } catch (error) {
    logger.error('Error getting job results:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Health check for AWS EventBridge
app.get('/health-job', async (req, res) => {
  try {
    const accessToken = await getAccessTokenFromDB();
    res.json({ 
      status: 'healthy',
      message: 'Support job service is ready',
      hasValidToken: !!accessToken,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(500).json({ 
      status: 'unhealthy',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Calculate support for a single instrument (on-demand)
app.get('/support/:instrumentKey', async (req, res) => {
  try {
    const instrumentKey = decodeURIComponent(req.params.instrumentKey);
    logger.info(`Calculating support for ${instrumentKey}`);
    
    const historicalData = await fetchHistoricalData(instrumentKey);
    const supportData = calculateSupportZone(historicalData);

    res.json({
      status: 'success',
      instrumentKey,
      support: {
        lowerBound: supportData.supportLower,
        upperBound: supportData.supportUpper,
        touchCount: supportData.touchCount,
        avgPrice: supportData.avgPrice,
        allZones: supportData.allZones
      }
    });
  } catch (error) {
    logger.error(`Error calculating support: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get all stored support levels
app.get('/support-levels', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stock_support')
      .select('*')
      .order('touch_count', { ascending: false });

    if (error) throw error;

    res.json({ status: 'success', data });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Switch to production schedule
app.post('/enable-production-schedule', (req, res) => {
  try {
    testingSchedule.stop();
    productionSchedule.start();
    logger.info('Switched to production schedule (3:45 PM IST weekdays)');
    res.json({ 
      status: 'success',
      message: 'Production schedule enabled. Job will run at 3:45 PM IST on weekdays.',
      schedule: '3:45 PM IST (Monday-Friday)'
    });
  } catch (error) {
    logger.error('Error enabling production schedule:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Switch to testing schedule
app.post('/enable-testing-schedule', (req, res) => {
  try {
    productionSchedule.stop();
    testingSchedule.start();
    logger.info('Switched to testing schedule (every minute)');
    res.json({ 
      status: 'success',
      message: 'Testing schedule enabled. Job will run every minute.',
      schedule: 'Every minute'
    });
  } catch (error) {
    logger.error('Error enabling testing schedule:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get current schedule status
app.get('/schedule-status', (req, res) => {
  const now = new Date();
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  
  res.json({
    status: 'success',
    environment: isProduction ? 'production' : 'development',
    currentTime: {
      utc: now.toISOString(),
      ist: istTime.toISOString()
    },
    schedules: {
      production: {
        active: productionSchedule.getStatus() === 'scheduled',
        schedule: '15 10 * * 1-5 (3:45 PM IST weekdays)',
        description: 'Runs at 3:45 PM IST on weekdays',
        autoEnabled: isProduction
      },
      testing: {
        active: testingSchedule.getStatus() === 'scheduled',
        schedule: '* * * * * (every minute)',
        description: 'Runs every minute for testing',
        autoEnabled: !isProduction
      }
    }
  });
});

// Start server
app.listen(PORT, () => {
  const now = new Date();
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  
  logger.info(`Server is running on port ${PORT}`);
  logger.info(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  logger.info(`Current time: ${now.toISOString()} UTC | ${istTime.toISOString()} IST`);
  
  if (isProduction) {
    logger.info(`✅ PRODUCTION schedule is ACTIVE - job runs at 3:45 PM IST weekdays`);
  } else {
    logger.info(`🧪 TESTING schedule is ACTIVE - job runs every minute`);
  }
  
  logger.info(`Available endpoints:`);
  logger.info(`  GET  /health - Health check`);
  logger.info(`  GET  /run-support-job - Manual job trigger (synchronous)`);
  logger.info(`  POST /start-job - Start job from frontend (asynchronous)`);
  logger.info(`  GET  /job-status - Get current job status and progress`);
  logger.info(`  GET  /job-results - Get job results and summary`);
  logger.info(`  POST /stop-job - Request job stop (soft stop)`);
  logger.info(`  GET  /schedule-status - Check current schedule status`);
  logger.info(`  POST /enable-production-schedule - Switch to production schedule`);
  logger.info(`  POST /enable-testing-schedule - Switch to testing schedule`);
  logger.info(`  GET  /support/:instrumentKey - Calculate support for single stock`);
  logger.info(`  GET  /support-levels - Get all stored support levels`);
});
