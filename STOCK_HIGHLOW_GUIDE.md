# Stock High/Low Setup Guide

## Problem Fixed
1. ✅ Added API endpoint to fetch high/low data from database
2. ✅ Added API endpoint to add new stock instruments
3. ✅ Fixed logger in stock-highlow-job.js
4. ✅ Created tools to manage stocks

## New API Endpoints

### 1. Get High/Low Data
```
GET http://localhost:3000/api/stocks/highlow
```
Returns all stocks with their 52-week high/low values.

### 2. Add New Stocks
```
POST http://localhost:3000/api/stocks/add
Content-Type: application/json

{
  "instruments": [
    {
      "instrument_key": "NSE_EQ|INE002A01018",
      "company_name": "Reliance Industries Limited",
      "symbol": "RELIANCE",
      "exchange": "NSE_EQ",
      "sector": "Energy"
    }
  ]
}
```

### 3. List All Stock Instruments
```
GET http://localhost:3000/api/stocks/instruments
```

## How to Use

### Step 1: Start the main server
```bash
node index.js
```

### Step 2: Start the high/low job server
```bash
node stock-highlow-job.js
```

### Step 3: Add new stocks to database

Edit `add-stocks.js` and modify the `newStocks` array with your stocks, then run:

```bash
# Add stocks to database
node add-stocks.js add

# List all stocks
node add-stocks.js list

# View high/low data
node add-stocks.js highlow
```

### Step 4: Run the high/low job

The job runs automatically every minute (testing mode). To run manually:

```bash
curl http://localhost:3002/run-highlow-job
```

Or visit: http://localhost:3002/run-highlow-job in your browser

### Step 5: View the data

Open `stock-highlow-viewer.html` in your browser to see a nice table with all high/low data.

Or use the API:
```bash
curl http://localhost:3000/api/stocks/highlow
```

## Quick Commands

```bash
# Add stocks
node add-stocks.js add

# List all instruments
node add-stocks.js list

# View high/low data
node add-stocks.js highlow

# Run job manually
curl http://localhost:3002/run-highlow-job

# Check job status
curl http://localhost:3002/schedule-status
```

## Example: Adding Multiple Stocks

Edit `add-stocks.js` and add your stocks:

```javascript
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
  }
  // Add more stocks here...
];
```

Then run: `node add-stocks.js add`

## Troubleshooting

### High/Low shows N/A
- Make sure the stock is added to `stock_instruments` table
- Run the high/low job: `curl http://localhost:3002/run-highlow-job`
- Wait for the job to complete (it fetches historical data from Upstox)

### Stock not in database
- Use `node add-stocks.js add` to add new stocks
- Or use the API: `POST http://localhost:3000/api/stocks/add`

### Job not running
- Check if stock-highlow-job.js is running on port 3002
- Check logs in `highlow-job.log`
- Verify Upstox access token is valid

## Production Mode

To switch to production schedule (3:35 PM IST weekdays):

```bash
curl -X POST http://localhost:3002/enable-production-schedule
```

To switch back to testing (every minute):

```bash
curl -X POST http://localhost:3002/enable-testing-schedule
```
