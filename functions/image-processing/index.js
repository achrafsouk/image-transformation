const AWS = require('aws-sdk');
const https = require('https');
const Sharp = require('sharp');

const keepAliveAgent = new https.Agent({keepAlive: true});
const S3 = new AWS.S3({signatureVersion: 'v4',httpOptions: {agent: keepAliveAgent}}); 
const S3_BUCKET = process.env.bucketName; 
const TRANSFORMED_IMAGE_PREFIX = process.env.transformedImagePrefix;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const SECRET_KEY = process.env.secretKey;
const STORE_TRANSFORMED_IMAGES = process.env.storeTransformedImages;
const LOG_TIMING = process.env.logTiming;

exports.handler = async (event) => {
    // First validate if the request is coming from CloudFront
    if (!event.headers['x-origin-secret-header'] || !(event.headers['x-origin-secret-header'] === SECRET_KEY)) return sendError(403, 'Request unauthorized', event);
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);

    // The request triggering this function used the */images/* cache behavio.
    // An example of expected path is /hashValue/format=auto,width=100/images/rio/1.jpg
    var imagePathArray= event.requestContext.http.path.split('/');
    imagePathArray.shift(); // Get rid of first slash 
    imagePathArray.shift(); // remove the hash 
    // get the prefix which corresponds to requested image operatioons
    var operationsPrefix = imagePathArray.shift(); 
    // with the prefix removed, we get the original image path on the S3 bucket
    var originalImagePath = imagePathArray.join('/');
    // timing variable
    var timingLog = "perf ";
    var startTime = performance.now();
    // Downloading original image
    let originalImage;
    let contentType;
    try {
        originalImage = await S3.getObject({ Bucket: S3_BUCKET, Key: originalImagePath }).promise();
        contentType = originalImage.ContentType;
    } catch (error) {
        return sendError(500, 'error downloading original image', error);
    }
    let sharpObject = Sharp(originalImage.Body);
    let transformedImage;
    //  execute the requested oprations 
    var operationsJSON = {};
    var operationsArray = operationsPrefix.split(',');
    operationsArray.forEach(operation => {
        var operationKV = operation.split("=");
        operationsJSON[operationKV[0]] = operationKV[1];
    });
    timingLog = timingLog + parseInt(performance.now()-startTime) + ' ';
    startTime = performance.now();
    try {
        // check if resizing is requested
        var resizingOptions = {};
        if (operationsJSON['width']) resizingOptions.width = parseInt(operationsJSON['width']);
        if (operationsJSON['height']) resizingOptions.height = parseInt(operationsJSON['height']);
        if (resizingOptions) transformedImage = sharpObject.resize(resizingOptions);
        // check if formatting is requested
        if (operationsJSON['format']) {
            var isLossy = false;
            switch (operationsJSON['format'])
            {
               case 'jpeg': contentType = 'image/jpeg'; isLossy = true; break;
               case 'svg': contentType = 'image/svg+xml'; break;
               case 'gif': contentType = 'image/gif'; break;
               case 'webp': contentType = 'image/webp'; isLossy = true; break;
               case 'png': contentType = 'image/png'; break;
               case 'avif': contentType = 'image/avif'; isLossy = true; break;
               default : contentType = 'image/jpeg'; isLossy = true;
            }
            if (operationsJSON['quality'] && isLossy) {
                transformedImage = transformedImage.toFormat(operationsJSON['format'], {
                    quality: parseInt(operationsJSON['quality']),
                });
            } else transformedImage = transformedImage.toFormat(operationsJSON['format']);
        }
        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }
    timingLog = timingLog + parseInt(performance.now()-startTime) + ' ';
    startTime = performance.now();
    // upload transformed image back to S3 if required in the architecture
    if (STORE_TRANSFORMED_IMAGES === 'true') {
        try { 
            await S3.putObject({
                Body: transformedImage, 
                Bucket: S3_BUCKET, 
                Key:  TRANSFORMED_IMAGE_PREFIX + event.requestContext.http.path, 
                ContentType: contentType,
                Metadata: {
                    'cache-control': TRANSFORMED_IMAGE_CACHE_TTL,
                },
            }, function(err, data) {});
        } catch (error) {
            sendError('APPLICATION ERROR', 'Could not upload transformated image to S3', error);
        }
    }
    timingLog = timingLog + parseInt(performance.now()-startTime) + ' ';
    if (LOG_TIMING === 'true') console.log(timingLog);
    // return transformed image
    return {
        statusCode: 200,
        body: transformedImage.toString('base64'),
        isBase64Encoded: true,
        headers: {
            'Content-Type': contentType, 
            'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL 
        }
    };
};

function sendError(code, message, error){
    console.log('APPLICATION ERROR', message);
    console.log(error);
    return {
        statusCode: code,
        body: message,
    };
}
