# Stock High/Low Job API Documentation

## Overview

This API allows frontend applications to control and monitor the stock high/low calculation job. The job processes all active stock instruments and calculates their 52-week high and low values.

## Base URL

```
http://localhost:3002
```

## Endpoints

### 1. Start Job (Asynchronous)

**POST** `/start-job`

Starts the job asynchronously and returns immediately with job status.

**Response:**
```json
{
  "status": "success",
  "message": "Job started successfully",
  "jobId": "2024-01-07T10:30:00.000Z",
  "jobStatus": {
    "isRunning": true,
    "startTime": "2024-01-07T10:30:00.000Z",
    "progress": {
      "total": 0,
      "completed": 0,
      "failed": 0,
      "current": null
    }
  }
}
```

**Error Response (Job Already Running):**
```json
{
  "status": "error",
  "message": "Job is already running. Please wait for it to complete.",
  "jobStatus": {
    "isRunning": true,
    "startTime": "2024-01-07T10:30:00.000Z",
    "progress": {
      "total": 100,
      "completed": 45,
      "failed": 2,
      "current": "NSE_EQ|INE002A01018"
    }
  }
}
```

### 2. Get Job Status

**GET** `/job-status`

Returns current job status and progress information.

**Response:**
```json
{
  "status": "success",
  "jobStatus": {
    "isRunning": true,
    "startTime": "2024-01-07T10:30:00.000Z",
    "endTime": null,
    "progress": {
      "total": 100,
      "completed": 45,
      "failed": 2,
      "current": "NSE_EQ|INE002A01018"
    },
    "results": null,
    "error": null,
    "duration": 120,
    "progressPercentage": 47
  }
}
```

**Response (Job Completed):**
```json
{
  "status": "success",
  "jobStatus": {
    "isRunning": false,
    "startTime": "2024-01-07T10:30:00.000Z",
    "endTime": "2024-01-07T10:35:30.000Z",
    "progress": {
      "total": 100,
      "completed": 95,
      "failed": 5,
      "current": null
    },
    "results": { /* detailed results */ },
    "error": null,
    "duration": 330,
    "progressPercentage": 100
  }
}
```

### 3. Get Job Results

**GET** `/job-results`

Returns detailed job results and summary.

**Response:**
```json
{
  "status": "success",
  "jobStatus": {
    "isRunning": false,
    "startTime": "2024-01-07T10:30:00.000Z",
    "endTime": "2024-01-07T10:35:30.000Z",
    "progress": {
      "total": 100,
      "completed": 95,
      "failed": 5,
      "current": null
    },
    "error": null
  },
  "results": {
    "successful": [
      {
        "instrumentKey": "NSE_EQ|INE002A01018",
        "high": 1250.75,
        "low": 890.25,
        "name": "Reliance Industries Ltd",
        "symbol": "RELIANCE",
        "exchange": "NSE_EQ",
        "sector": "Energy"
      }
    ],
    "failed": [
      {
        "instrumentKey": "NSE_EQ|INE123A01012",
        "error": "No data available"
      }
    ]
  },
  "summary": {
    "totalProcessed": 100,
    "successful": 95,
    "failed": 5,
    "successRate": 95
  }
}
```

### 4. Stop Job (Soft Stop)

**POST** `/stop-job`

Requests job to stop. Note: This is a soft stop - current processing will complete.

**Response:**
```json
{
  "status": "success",
  "message": "Job stop requested. Note: Current processing will complete, but no new instruments will be processed.",
  "jobStatus": {
    "isRunning": true,
    "progress": {
      "total": 100,
      "completed": 45,
      "failed": 2,
      "current": "NSE_EQ|INE002A01018"
    }
  }
}
```

### 5. Manual Job Trigger (Synchronous)

**GET** `/run-highlow-job`

Runs the job synchronously and waits for completion. Used by AWS EventBridge.

**Response:**
```json
{
  "status": "success",
  "message": "Job completed",
  "results": {
    "successful": [...],
    "failed": [...]
  }
}
```

### 6. Health Check

**GET** `/health`

Simple health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

## Frontend Integration Example

### JavaScript/React Example

```javascript
class JobController {
  constructor(baseUrl = 'http://localhost:3002') {
    this.baseUrl = baseUrl;
    this.statusInterval = null;
  }

  async startJob() {
    try {
      const response = await fetch(`${this.baseUrl}/start-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      return await response.json();
    } catch (error) {
      throw new Error(`Failed to start job: ${error.message}`);
    }
  }

  async getStatus() {
    try {
      const response = await fetch(`${this.baseUrl}/job-status`);
      return await response.json();
    } catch (error) {
      throw new Error(`Failed to get status: ${error.message}`);
    }
  }

  async getResults() {
    try {
      const response = await fetch(`${this.baseUrl}/job-results`);
      return await response.json();
    } catch (error) {
      throw new Error(`Failed to get results: ${error.message}`);
    }
  }

  startPolling(callback, interval = 2000) {
    this.statusInterval = setInterval(async () => {
      try {
        const status = await this.getStatus();
        callback(status);
        
        // Stop polling when job completes
        if (!status.jobStatus.isRunning) {
          this.stopPolling();
        }
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, interval);
  }

  stopPolling() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
  }
}

// Usage
const jobController = new JobController();

// Start job and monitor progress
async function runJob() {
  try {
    const startResult = await jobController.startJob();
    console.log('Job started:', startResult);
    
    // Start polling for status updates
    jobController.startPolling((status) => {
      console.log('Progress:', status.jobStatus.progressPercentage + '%');
      
      if (!status.jobStatus.isRunning) {
        console.log('Job completed!');
        // Get final results
        jobController.getResults().then(results => {
          console.log('Results:', results);
        });
      }
    });
  } catch (error) {
    console.error('Error:', error);
  }
}
```

## Job Status Fields

- **isRunning**: Boolean indicating if job is currently running
- **startTime**: ISO timestamp when job started
- **endTime**: ISO timestamp when job completed (null if running)
- **progress.total**: Total number of instruments to process
- **progress.completed**: Number of successfully processed instruments
- **progress.failed**: Number of failed instruments
- **progress.current**: Currently processing instrument key
- **duration**: Job duration in seconds
- **progressPercentage**: Completion percentage (0-100)
- **results**: Detailed results (only available after completion)
- **error**: Error message if job failed

## Error Handling

All endpoints return consistent error responses:

```json
{
  "status": "error",
  "message": "Error description"
}
```

Common HTTP status codes:
- **200**: Success
- **400**: Bad request (e.g., invalid parameters)
- **404**: Resource not found (e.g., no results available)
- **409**: Conflict (e.g., job already running)
- **500**: Internal server error

## Rate Limiting

The job processes instruments sequentially to avoid API rate limits. Typical processing time:
- ~2-3 seconds per instrument
- 100 instruments ≈ 3-5 minutes total

## Notes

1. Only one job can run at a time
2. Job progress is tracked in memory (resets on server restart)
3. Use polling to monitor job progress
4. The `/run-highlow-job` endpoint is synchronous and may timeout for large datasets
5. Use `/start-job` + `/job-status` polling for better user experience