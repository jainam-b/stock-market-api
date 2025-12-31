#!/bin/bash

# Stop all running services

echo "🛑 Stopping all services..."

if [ -f .pids ]; then
    echo "📋 Found PID file, stopping processes..."
    while read pid; do
        if ps -p $pid > /dev/null 2>&1; then
            echo "   Stopping process $pid..."
            kill $pid
        fi
    done < .pids
    rm .pids
    echo "✅ Services stopped"
else
    echo "⚠️  No PID file found, trying to kill by name..."
    pkill -f 'node index.js'
    pkill -f 'node stock-highlow-job.js'
    echo "✅ Kill signals sent"
fi

echo ""
echo "🔍 Checking for remaining processes..."
ps aux | grep -E 'node (index|stock-highlow-job)' | grep -v grep || echo "   No processes found"
