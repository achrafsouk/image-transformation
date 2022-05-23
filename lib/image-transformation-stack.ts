const AWS = require('aws-sdk');
const https = require('https');
const Sharp = require('sharp');

const keepAliveAgent = new https.Agent({keepAlive: true});
const S3 = new AWS.S3({signatureVersion: 'v4',httpOptions: {agent: keepAliveAgent}}); //TODO, is it still needed?
const S3_BUCKET = process.env.bucketName; 
const TRANSFORMED_IMAGE_PREFIX = process.env.transformedImagePrefix;
const SECRET_KEY = process.env.secretKey;
const TRANSFORMED_IMAGE_TTL = process.env.transformedImageTTL;

exports.handler = async (event) => {
    // First validate if the request is coming from CloudFront
    if (!event.headers["x-origin-secret-header"] || !(event.headers["x-origin-secret-header"] === SECRET_KEY)) return sendError(403, 'Request unathorized', event);
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);

    // The request triggering this function used the */images/* cache behavio.
    // An example of expected path is /format=auto,width=100/images/cats/cat1.jpg
    var imagePathArray= event.requestContext.http.path.split("/");
    imagePathArray.shift(); // Get rid of first slash
    // get the prefix which corresponds to requested image operatioons
    var operationsPrefix = imagePathArray.shift(); 
    console.log('operationsPrefix', operationsPrefix);
    // with the prefix removed, we get the original image path on the S3 bucket
    var originalImagePath = imagePathArray.join('/');
    // Downloading original image
    let originalImage;
    let contentType;
    try {
        originalImage = await S3.getObject({ Bucket: S3_BUCKET, Key: originalImagePath }).promise();
        contentType = originalImage.ContentType;
    } catch (error) {
        console.log(error);
        return sendError(500, 'error downloading original image', event);
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

    try {
        // check if resizing is requested
        var resizingOptions = {};
        if (operationsJSON['width']) resizingOptions.width = parseInt(operationsJSON['width']);
        if (operationsJSON['height']) resizingOptions.height = parseInt(operationsJSON['height']);
        if (resizingOptions) transformedImage = await sharpObject.resize(resizingOptions);
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
                transformedImage = await transformedImage.toFormat(operationsJSON['format'], {
                    quality: parseInt(operationsJSON['quality']),
                });
            } else transformedImage = await transformedImage.toFormat(operationsJSON['format']);
        }
        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        console.log(error);
        return sendError(500, 'error transforming image', event);
    }

    // upload transformed image back to S3
    try { 
        await S3.putObject({
            Body: transformedImage, 
            Bucket: S3_BUCKET, 
            Key:  TRANSFORMED_IMAGE_PREFIX + event.requestContext.http.path, 
            StorageClass: "ONEZONE_IA",
            ContentType: contentType,
            
            Metadata: {
                'cache-control': 'max-age='+TRANSFORMED_IMAGE_TTL,
            },
        }, function(err, data) {});
    } catch (error) {
        console.log('APPLICATION ERROR', 'Could not upload transformated image to S3');
        console.log(JSON.stringify(event));
    }

    return {
        statusCode: 200,
        body: transformedImage.toString('base64'),
        isBase64Encoded: true,
        headers: {
            'Content-Type': contentType, 
            'Cache-Control': 'max-age='+TRANSFORMED_IMAGE_TTL 
        }
    };
};

function sendError(code, message, event){
    console.log('APPLICATION ERROR', message);
    console.log(JSON.stringify(event));
    return {
        statusCode: code,
        body: message,
    };
}
