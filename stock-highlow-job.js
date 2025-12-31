// Import required modules
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');

// This script fetches active stock instruments from the database
// and calculates their 52-week high and low values

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3002;

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'highlow-job.log' })
  ]
});

// Configure Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  logger.error('Supabase credentials are missing. Please check your environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Upstox API configuration
const UPSTOX_API_URL = 'https://api.upstox.com/v3/historical-candle/';

// Function to fetch access token from database (single row approach)
const getAccessTokenFromDB = async () => {
  try {
    logger.info('Fetching access token from database...');
    
    // Get the single token row for upstox provider
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

    // Check if token is expired
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      throw new Error('Access token has expired');
    }

    logger.info('Successfully fetched access token from database');
    return data.token;
  } catch (error) {
    logger.error('Failed to get access token:', error.message);
    // Fallback to environment variable if database fails
    const fallbackToken = process.env.UPSTOX_ACCESS_TOKEN;
    if (fallbackToken) {
      logger.warn('Using fallback access token from environment variable');
      return fallbackToken;
    }
    throw error;
  }
};

// Function to fetch active instruments from the stock_instruments table
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
    
    // Extract instrument keys from the result
    const instruments = data.map(item => item.instrument_key);
    logger.info(`Found ${instruments.length} active instruments`);
    
    return instruments;
  } catch (error) {
    logger.error('Failed to fetch active instruments:', error.message);
    throw error;
  }
}

// Function to fetch historical data from Upstox
async function fetchHistoricalData(instrumentKey) {
  try {
    const accessToken = await getAccessTokenFromDB();
    
    // Calculate date range for 52 weeks (365 days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 365);

    // Format dates as YYYY-MM-DD
    const formatDate = (date) => {
      return date.toISOString().split('T')[0];
    };

    // Format: /v3/historical-candle/:instrument_key/:unit/:interval/:to_date/:from_date
    const unit = 'days';
    const interval = '1';
    const toDate = formatDate(endDate);
    const fromDate = formatDate(startDate);
    
    const url = `${UPSTOX_API_URL}${instrumentKey}/${unit}/${interval}/${toDate}/${fromDate}`;
    
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    };

    logger.info(`Fetching historical data for ${instrumentKey} from ${fromDate} to ${toDate}`);
    
    const response = await axios.get(url, { headers });
    return response.data;
  } catch (error) {
    logger.error(`Error fetching historical data for ${instrumentKey}:`, error.message);
    if (error.response) {
      logger.error(`Response status: ${error.response.status}, data:`, error.response.data);
    }
    throw error;
  }
}

// Function to calculate 52-week high and low
function calculate52WeekHighLow(data) {
  try {
    if (!data || !data.data || !data.data.candles || data.data.candles.length === 0) {
      throw new Error('Invalid or empty data received');
    }

    const candles = data.data.candles;
    
    // Initialize high and low with the first candle's high and low
    let high = candles[0][2]; // High value from first candle
    let low = candles[0][3];  // Low value from first candle
    
    // Iterate through all candles to find the highest high and lowest low
    for (const candle of candles) {
      const candleHigh = candle[2];
      const candleLow = candle[3];
      
      if (candleHigh > high) {
        high = candleHigh;
      }
      
      if (candleLow < low) {
        low = candleLow;
      }
    }
    
    return { high, low };
  } catch (error) {
    logger.error('Error calculating 52-week high/low:', error.message);
    throw error;
  }
}

// Simple function to check if we can access a table
async function canAccessTable(tableName) {
  try {
    // Try to select a single row with limit 1 to check if the table is accessible
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .limit(1);
    
    // If there's no error, the table exists and is accessible
    return !error;
  } catch (error) {
    logger.warn(`Cannot access table ${tableName}: ${error.message}`);
    return false;
  }
}

// Function to fetch stock information from the stock_instruments table
async function fetchStockInformation(instrumentKey) {
  try {
    logger.info(`Fetching stock information for ${instrumentKey}`);
    
    // Extract the instrument parts (e.g., NSE_EQ|INE002A01018 -> NSE_EQ, INE002A01018)
    const parts = instrumentKey.split('|');
    const exchange = parts[0] || null;
    const symbol = parts.length > 1 ? parts[1] : null;
    
    // Default values based on the instrument key
    const defaultInfo = {
      name: null,
      symbol: symbol,
      exchange: exchange,
      sector: null
    };
    
    // Check if we can access the stock_instruments table
    const canAccess = await canAccessTable('stock_instruments');
    
    if (!canAccess) {
      logger.warn(`Cannot access stock_instruments table. Using default information for ${instrumentKey}`);
      return defaultInfo;
    }
    
    // Try to query the table with the correct columns
    try {
      const { data, error } = await supabase
        .from('stock_instruments')
        .select('company_name, symbol, exchange, sector')
        .eq('instrument_key', instrumentKey)
        .single();
        
      if (error) {
        logger.warn(`No stock information found for ${instrumentKey}: ${error.message}`);
        return defaultInfo;
      }
      
      logger.info(`Found stock information for ${instrumentKey}: ${JSON.stringify(data)}`);
      
      // Use data if available, otherwise use defaults
      return {
        name: data.company_name || defaultInfo.name,
        symbol: data.symbol || defaultInfo.symbol,
        exchange: data.exchange || defaultInfo.exchange,
        sector: data.sector || defaultInfo.sector
      };
    } catch (error) {
      logger.warn(`Error querying stock_instruments table: ${error.message}. Using default information.`);
      return defaultInfo;
    }
  } catch (error) {
    logger.error(`Error fetching stock information for ${instrumentKey}:`, error.message);
    return {
      name: null,
      symbol: null,
      exchange: null,
      sector: null
    };
  }
}

// Function to save data to Supabase
async function saveToSupabase(instrumentKey, high, low, stockInfo) {
  try {
    logger.info(`Saving data for ${instrumentKey}: high=${high}, low=${low}`);
    
    // Create a data object with required fields
    const dataToSave = {
      instrument_key: instrumentKey,
      high: high,
      low: low,
      updated_at: new Date().toISOString(),
      is_active: true
    };
    
    // Add optional fields if they exist
    if (stockInfo) {
      if (stockInfo.name !== undefined && stockInfo.name !== null) {
        dataToSave.name = stockInfo.name;
      }
      
      if (stockInfo.symbol !== undefined && stockInfo.symbol !== null) {
        dataToSave.symbol = stockInfo.symbol;
      }
      
      if (stockInfo.exchange !== undefined && stockInfo.exchange !== null) {
        dataToSave.exchange = stockInfo.exchange;
      }
      
      if (stockInfo.sector !== undefined && stockInfo.sector !== null) {
        dataToSave.sector = stockInfo.sector;
      }
    }
    
    // Check if we can access the stock_highlow table
    const canAccess = await canAccessTable('stock_highlow');
    
    if (!canAccess) {
      logger.error(`Cannot access stock_highlow table. Cannot save data for ${instrumentKey}`);
      throw new Error('Cannot access stock_highlow table');
    }
    
    // Perform the upsert operation
    const { data, error } = await supabase
      .from('stock_highlow')
      .upsert(
        dataToSave,
        { 
          onConflict: 'instrument_key',
          ignoreDuplicates: false
        }
      );
      
    if (error) {
      logger.error(`Error in Supabase upsert for ${instrumentKey}: ${error.message}`);
      throw error;
    }
    
    logger.info(`Successfully saved data for ${instrumentKey}`);
    return data;
  } catch (error) {
    logger.error(`Error saving data to Supabase for ${instrumentKey}: ${error.message}`);
    throw error;
  }
}

// Function to ensure instrument exists in stock_instruments table
async function ensureInstrumentExists(instrumentKey, stockInfo) {
  try {
    // Extract parts from instrument key
    const parts = instrumentKey.split('|');
    const exchange = parts[0] || '';
    const symbol = parts.length > 1 ? parts[1] : '';
    
    // Check if we can access the stock_instruments table
    const canAccess = await canAccessTable('stock_instruments');
    
    if (!canAccess) {
      logger.warn(`Cannot access stock_instruments table. Cannot ensure instrument exists: ${instrumentKey}`);
      return false;
    }
    
    // Check if the instrument already exists
    const { data, error } = await supabase
      .from('stock_instruments')
      .select('id')
      .eq('instrument_key', instrumentKey)
      .maybeSingle();
    
    if (data) {
      // Instrument exists
      logger.info(`Instrument ${instrumentKey} already exists in stock_instruments table`);
      return true;
    }
    
    // Instrument doesn't exist, create it
    const { error: insertError } = await supabase
      .from('stock_instruments')
      .insert({
        instrument_key: instrumentKey,
        company_name: stockInfo?.name || 'Unknown',
        symbol: stockInfo?.symbol || symbol,
        exchange: stockInfo?.exchange || exchange,
        sector: stockInfo?.sector || null,
        is_active: true
      });
    
    if (insertError) {
      logger.error(`Failed to insert instrument ${instrumentKey} into stock_instruments table: ${insertError.message}`);
      return false;
    }
    
    logger.info(`Successfully created instrument ${instrumentKey} in stock_instruments table`);
    return true;
  } catch (error) {
    logger.error(`Error ensuring instrument exists for ${instrumentKey}: ${error.message}`);
    return false;
  }
}

// Function to process each instrument
async function processInstrument(instrumentKey) {
  try {
    // Fetch historical data
    const historicalData = await fetchHistoricalData(instrumentKey);
    
    // Calculate 52-week high and low
    const { high, low } = calculate52WeekHighLow(historicalData);
    
    // Fetch additional stock information
    const stockInfo = await fetchStockInformation(instrumentKey);
    
    // Ensure the instrument exists in stock_instruments table
    const instrumentExists = await ensureInstrumentExists(instrumentKey, stockInfo);
    
    if (!instrumentExists) {
      throw new Error(`Could not ensure instrument ${instrumentKey} exists in stock_instruments table`);
    }
    
    // Save to Supabase with the additional information
    await saveToSupabase(instrumentKey, high, low, stockInfo);
    
    return { 
      instrumentKey, 
      high, 
      low,
      name: stockInfo?.name,
      symbol: stockInfo?.symbol,
      exchange: stockInfo?.exchange,
      sector: stockInfo?.sector
    };
  } catch (error) {
    logger.error(`Failed to process instrument ${instrumentKey}:`, error.message);
    return { instrumentKey, error: error.message };
  }
}

// Main function to run the job
async function runHighLowJob() {
  logger.info('Starting 52-week high/low job');
  
  const results = {
    successful: [],
    failed: []
  };
  
  try {
    // Fetch active instruments from the database
    const instruments = await fetchActiveInstruments();
    
    if (instruments.length === 0) {
      logger.warn('No instruments to process. Job completed.');
      return results;
    }
    
    logger.info(`Processing ${instruments.length} instruments`);
    
    // Process each instrument sequentially to avoid rate limits
    for (const instrument of instruments) {
      try {
        const result = await processInstrument(instrument);
        if (result.error) {
          results.failed.push(result);
        } else {
          results.successful.push(result);
        }
      } catch (error) {
        results.failed.push({ instrumentKey: instrument, error: error.message });
      }
    }
  } catch (error) {
    logger.error(`Error fetching instruments: ${error.message}`);
    return {
      successful: [],
      failed: [{ instrumentKey: 'FETCH_INSTRUMENTS', error: error.message }]
    };
  }
  
  logger.info(`Job completed. Successfully processed: ${results.successful.length}, Failed: ${results.failed.length}`);
  return results;
}

// PRODUCTION SCHEDULE - 3:30 PM IST every weekday (Monday to Friday)
// IST is UTC+5:30, so 3:30 PM IST is 10:00 AM UTC
// Cron format: minute hour day month day-of-week
// For 3:30 PM IST = 15:30 IST = 10:00 UTC = minute=0, hour=10
const productionSchedule = cron.schedule('0 10 * * 1-5', async () => {
  try {
    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000)); // Convert to IST
    logger.info(`[PRODUCTION] Running scheduled 52-week high/low job at ${istTime.toISOString()} IST (${now.toISOString()} UTC)`);
    await runHighLowJob();
    logger.info('[PRODUCTION] Scheduled job completed');
  } catch (error) {
    logger.error('[PRODUCTION] Error in scheduled job:', error);
  }
}, {
  scheduled: false, // Will be enabled based on NODE_ENV
  timezone: "UTC"
});

// TESTING SCHEDULE - Runs every minute
const testingSchedule = cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000)); // Convert to IST
    logger.info(`[TEST MODE] Running scheduled 52-week high/low job at ${istTime.toISOString()} IST (${now.toISOString()} UTC)`);
    await runHighLowJob();
    logger.info('[TEST MODE] Scheduled job completed');
  } catch (error) {
    logger.error('[TEST MODE] Error in scheduled job:', error);
  }
}, {
  scheduled: false, // Will be enabled based on NODE_ENV
  timezone: "UTC"
});

// Determine which schedule to use based on environment
const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod';

if (isProduction) {
  productionSchedule.start();
  logger.info('🚀 PRODUCTION MODE: Schedule enabled - Job will run at 3:30 PM IST on weekdays');
} else {
  testingSchedule.start();
  logger.info('🧪 TESTING MODE: Schedule enabled - Job will run every minute');
}

// API endpoint to manually trigger the job
app.get('/run-highlow-job', async (req, res) => {
  try {
    logger.info('Manually triggered 52-week high/low job');
    const results = await runHighLowJob();
    res.json({ 
      status: 'success',
      message: 'Job completed',
      results
    });
  } catch (error) {
    logger.error('Error running manual job:', error);
    res.status(500).json({ 
      status: 'error',
      message: error.message
    });
  }
});

// API endpoint to switch to production schedule
app.post('/enable-production-schedule', (req, res) => {
  try {
    testingSchedule.stop();
    productionSchedule.start();
    logger.info('Switched to production schedule (3:35 PM IST weekdays)');
    res.json({ 
      status: 'success',
      message: 'Production schedule enabled. Job will run at 3:35 PM IST on weekdays.',
      schedule: '3:35 PM IST (Monday-Friday)'
    });
  } catch (error) {
    logger.error('Error enabling production schedule:', error);
    res.status(500).json({ 
      status: 'error',
      message: error.message
    });
  }
});

// API endpoint to switch to testing schedule
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
    res.status(500).json({ 
      status: 'error',
      message: error.message
    });
  }
});

// API endpoint to get current schedule status
app.get('/schedule-status', (req, res) => {
  const now = new Date();
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod';
  
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
        schedule: '0 10 * * 1-5 (3:30 PM IST weekdays)',
        description: 'Runs at 3:30 PM IST on weekdays',
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start the server
app.listen(PORT, () => {
  const now = new Date();
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod';
  
  logger.info(`Server is running on port ${PORT}`);
  logger.info(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  logger.info(`Current time: ${now.toISOString()} UTC | ${istTime.toISOString()} IST`);
  
  if (isProduction) {
    logger.info(`✅ PRODUCTION schedule is ACTIVE - job runs at 3:30 PM IST weekdays`);
  } else {
    logger.info(`🧪 TESTING schedule is ACTIVE - job runs every minute`);
  }
  
  logger.info(`Available endpoints:`);
  logger.info(`  GET  /health - Health check`);
  logger.info(`  GET  /run-highlow-job - Manual job trigger`);
  logger.info(`  GET  /schedule-status - Check current schedule status`);
  logger.info(`  POST /enable-production-schedule - Switch to production schedule`);
  logger.info(`  POST /enable-testing-schedule - Switch to testing schedule`);
});