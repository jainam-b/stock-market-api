# AWS EventBridge Setup for Cron Job

## Why Use AWS EventBridge Instead of Node-Cron?

When deploying to AWS (Lambda, ECS, EC2), using AWS EventBridge is more reliable than node-cron because:
- Your application might not run continuously
- Better error handling and retry mechanisms
- Native AWS integration
- More reliable scheduling

## Setup Steps

### 1. Create EventBridge Rule

1. Go to AWS Console → EventBridge → Rules
2. Click "Create rule"
3. Configure:
   - **Name**: `stock-highlow-job-trigger`
   - **Description**: `Triggers stock high/low job at 3:30 PM IST weekdays`
   - **Event bus**: `default`
   - **Rule type**: `Schedule`

### 2. Set Schedule Pattern

Choose **Schedule pattern** and set:
- **Schedule expression**: `cron(30 9 ? * MON-FRI *)`
  - This runs at 9:30 AM UTC = 3:30 PM IST
  - Format: `cron(minute hour day month day-of-week year)`

### 3. Configure Target

1. **Target type**: `AWS service`
2. **Service**: Choose based on your deployment:

#### For Lambda:
- **Target**: `Lambda function`
- **Function**: Your deployed function
- **Input**: Constant JSON input: `{"trigger": "eventbridge"}`

#### For ECS/EC2 (HTTP endpoint):
- **Target**: `API Gateway` or `HTTP endpoint`
- **URL**: `https://your-domain.com/run-highlow-job`
- **HTTP method**: `GET`

#### For API Gateway:
- **Target**: `API Gateway`
- **API**: Your API Gateway
- **Stage**: `prod`
- **HTTP method**: `GET`
- **Resource path**: `/run-highlow-job`

### 4. Test the Setup

1. **Manual test**: Go to EventBridge → Rules → Your rule → Actions → "Send test event"
2. **Check logs**: Monitor your application logs to see if the job runs
3. **Verify endpoint**: Test `GET /run-highlow-job` manually first

## Alternative: AWS Lambda with EventBridge

If you want to use Lambda instead of a continuously running server:

### 1. Create Lambda Function

```javascript
// lambda-handler.js
const axios = require('axios');

exports.handler = async (event) => {
    try {
        console.log('EventBridge triggered Lambda at:', new Date().toISOString());
        
        // Call your application's job endpoint
        const response = await axios.get('https://your-domain.com/run-highlow-job', {
            timeout: 300000 // 5 minutes timeout
        });
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Job completed successfully',
                data: response.data
            })
        };
    } catch (error) {
        console.error('Error running job:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Job failed',
                error: error.message
            })
        };
    }
};
```

### 2. Deploy Lambda

1. Create Lambda function with Node.js runtime
2. Upload the code above
3. Set timeout to 5 minutes (or more if needed)
4. Add axios dependency via Lambda layers or zip upload

### 3. Configure EventBridge to trigger Lambda

Same as above, but target the Lambda function instead of HTTP endpoint.

## Troubleshooting

### Job Not Triggering
1. Check EventBridge rule is **Enabled**
2. Verify the cron expression: `cron(30 9 ? * MON-FRI *)`
3. Check target configuration
4. Look at EventBridge metrics in CloudWatch

### Job Fails
1. Check your application logs
2. Test the `/run-highlow-job` endpoint manually
3. Verify environment variables are set correctly
4. Check if your application is running and accessible

### Time Zone Issues
- EventBridge uses UTC time
- 3:30 PM IST = 9:30 AM UTC
- Use online cron expression testers to verify

## Current Application Changes

Your `stock-highlow-job.js` now has:
- Fixed cron expression: `'30 9 * * 1-5'` for 3:30 PM IST
- Enhanced `/run-highlow-job` endpoint for EventBridge
- New `/health-job` endpoint for health checks

## Recommended Approach

1. **Short term**: Fix the node-cron expression (already done)
2. **Long term**: Set up AWS EventBridge for more reliable scheduling
3. **Keep both**: Use EventBridge as primary, node-cron as backup