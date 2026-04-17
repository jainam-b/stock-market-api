// Setup script for stock_support table
// Run this once to create the required table in Supabase

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function setupTable() {
  console.log('Creating stock_support table...');
  
  // Note: Run this SQL in your Supabase SQL editor
  const sql = `
    CREATE TABLE IF NOT EXISTS stock_support (
      id SERIAL PRIMARY KEY,
      instrument_key TEXT UNIQUE NOT NULL,
      -- 1-month support
      support_lower DECIMAL(12, 2),
      support_upper DECIMAL(12, 2),
      touch_count INTEGER DEFAULT 0,
      avg_support_price DECIMAL(12, 2),
      all_zones JSONB,
      -- 12-month support
      support_lower_12m DECIMAL(12, 2),
      support_upper_12m DECIMAL(12, 2),
      touch_count_12m INTEGER DEFAULT 0,
      avg_support_price_12m DECIMAL(12, 2),
      all_zones_12m JSONB,
      -- timestamps
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_stock_support_instrument_key ON stock_support(instrument_key);
    CREATE INDEX IF NOT EXISTS idx_stock_support_touch_count ON stock_support(touch_count DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_support_touch_count_12m ON stock_support(touch_count_12m DESC);
    
    -- If table already exists, add the new 12-month columns
    ALTER TABLE stock_support ADD COLUMN IF NOT EXISTS support_lower_12m DECIMAL(12, 2);
    ALTER TABLE stock_support ADD COLUMN IF NOT EXISTS support_upper_12m DECIMAL(12, 2);
    ALTER TABLE stock_support ADD COLUMN IF NOT EXISTS touch_count_12m INTEGER DEFAULT 0;
    ALTER TABLE stock_support ADD COLUMN IF NOT EXISTS avg_support_price_12m DECIMAL(12, 2);
    ALTER TABLE stock_support ADD COLUMN IF NOT EXISTS all_zones_12m JSONB;
  `;

  console.log('\n=== Run this SQL in Supabase SQL Editor ===\n');
  console.log(sql);
  console.log('\n==========================================\n');

  // Test connection
  const { data, error } = await supabase.from('stock_instruments').select('count').limit(1);
  
  if (error) {
    console.error('Connection test failed:', error.message);
  } else {
    console.log('✓ Supabase connection successful');
  }
}

setupTable().catch(console.error);
