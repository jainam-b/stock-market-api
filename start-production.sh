#!/bin/bash

# Production startup script for Stock High/Low Service
# This script starts both the main server and the high/low job scheduler

echo "🚀 Starting services in PRODUCTION mode..."
echo ""

# Load production environment variables
if [ -f .env.prod ]; then
    echo "✅ Loading production environment from .env.prod"
    export $(cat .env.prod | grep -v '^#' | xargs)
else
    echo "⚠️  Warning: .env.prod not found, using default .env"
fi

# Ensure NODE_ENV is set to production
export NODE_ENV=production

echo "📊 Environment: $NODE_ENV"
echo "🌐 Port: ${PORT:-3000}"
echo ""

# Start the main server
echo "🔵 Starting main server (index.js)..."
node index.js &
MAIN_PID=$!
echo "   PID: $MAIN_PID"

# Wait a bit for main server to start
sleep 2

# Start the high/low job scheduler
echo "🟢 Starting high/low job scheduler (stock-highlow-job.js)..."
node stock-highlow-job.js &
JOB_PID=$!
echo "   PID: $JOB_PID"

echo ""
echo "✅ All services started!"
echo ""
echo "📋 Service Status:"
echo "   Main Server: http://localhost:${PORT:-3000}"
echo "   Job Scheduler: http://localhost:3002"
echo ""
echo "⏰ High/Low Job Schedule: 3:30 PM IST (Monday-Friday)"
echo ""
echo "🛑 To stop services, run: kill $MAIN_PID $JOB_PID"
echo "   Or use: pkill -f 'node index.js' && pkill -f 'node stock-highlow-job.js'"
echo ""

# Save PIDs to file for easy stopping
echo "$MAIN_PID" > .pids
echo "$JOB_PID" >> .pids

# Wait for both processes
wait
