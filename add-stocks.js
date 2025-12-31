// Script to add new stock instruments to the database
const axios = require('axios');

const API_URL = 'http://localhost:3000';

// Example stocks to add - modify this array with your stocks
const newStocks = [
  {
    instrument_key: 'NSE_EQ|INE002A01018',
    company_name: 'Reliance Industries Limited',
    symbol: 'RELIANCE',
    exchange: 'NSE_EQ',
    sector: 'Energy'
  },
  {
    instrument_key: 'NSE_EQ|INE040A01034',
    company_name: 'HDFC Bank Limited',
    symbol: 'HDFCBANK',
    exchange: 'NSE_EQ',
    sector: 'Banking'
  },
  {
    instrument_key: 'NSE_EQ|INE009A01021',
    company_name: 'Infosys Limited',
    symbol: 'INFY',
    exchange: 'NSE_EQ',
    sector: 'IT'
  },
  {
    instrument_key: 'NSE_EQ|INE467B01029',
    company_name: 'Tata Consultancy Services Limited',
    symbol: 'TCS',
    exchange: 'NSE_EQ',
    sector: 'IT'
  },
  {
    instrument_key: 'NSE_EQ|INE030A01027',
    company_name: 'Bharti Airtel Limited',
    symbol: 'BHARTIARTL',
    exchange: 'NSE_EQ',
    sector: 'Telecom'
  }
];

async function addStocks() {
  try {
    console.log(`📊 Adding ${newStocks.length} stocks to database...`);
    
    const response = await axios.post(`${API_URL}/api/stocks/add`, {
      instruments: newStocks
    });
    
    console.log('\n✅ Success!');
    console.log(`Added: ${response.data.results.added.length}`);
    console.log(`Skipped: ${response.data.results.skipped.length}`);
    console.log(`Failed: ${response.data.results.failed.length}`);
    
    if (response.data.results.added.length > 0) {
      console.log('\n📝 Added instruments:');
      response.data.results.added.forEach(stock => {
        console.log(`  - ${stock.symbol} (${stock.company_name})`);
      });
    }
    
    if (response.data.results.skipped.length > 0) {
      console.log('\n⏭️  Skipped (already exist):');
      response.data.results.skipped.forEach(item => {
        console.log(`  - ${item.instrument_key}`);
      });
    }
    
    if (response.data.results.failed.length > 0) {
      console.log('\n❌ Failed:');
      response.data.results.failed.forEach(item => {
        console.log(`  - ${item.instrument_key}: ${item.error}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

async function listStocks() {
  try {
    console.log('📋 Fetching all stock instruments...\n');
    
    const response = await axios.get(`${API_URL}/api/stocks/instruments`);
    
    console.log(`Found ${response.data.count} active instruments:\n`);
    response.data.data.forEach((stock, index) => {
      console.log(`${index + 1}. ${stock.symbol} - ${stock.company_name}`);
      console.log(`   Key: ${stock.instrument_key}`);
      console.log(`   Exchange: ${stock.exchange} | Sector: ${stock.sector || 'N/A'}\n`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

async function getHighLowData() {
  try {
    console.log('📊 Fetching high/low data...\n');
    
    const response = await axios.get(`${API_URL}/api/stocks/highlow`);
    
    console.log(`Found ${response.data.count} stocks with high/low data:\n`);
    response.data.data.forEach((stock, index) => {
      console.log(`${index + 1}. ${stock.symbol || stock.instrument_key}`);
      console.log(`   52w High: ₹${stock.high}`);
      console.log(`   52w Low: ₹${stock.low}`);
      console.log(`   Updated: ${new Date(stock.updated_at).toLocaleString()}\n`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

// Main execution
const command = process.argv[2];

switch (command) {
  case 'add':
    addStocks();
    break;
  case 'list':
    listStocks();
    break;
  case 'highlow':
    getHighLowData();
    break;
  default:
    console.log('Usage:');
    console.log('  node add-stocks.js add      - Add new stocks to database');
    console.log('  node add-stocks.js list     - List all stock instruments');
    console.log('  node add-stocks.js highlow  - Show high/low data for all stocks');
}
