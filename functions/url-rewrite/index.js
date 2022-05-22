function handler(event) {
    var request = event.request;
    var headers = request.headers;
    
    // The request triggering this function used the */images/* cache behavio.
    // An example of expected path is /format=auto,width=100/images/cats/cat1.jpg
    var imagePathArray= request.uri.toLowerCase().split("/");
    imagePathArray.shift(); // Get rid of first slash
    // get the prefix which corresponds to requested image operatioons
    var operationsPrefix = imagePathArray.shift(); 
    // with the prefix removed, we get the original image path on the S3 bucket
    var originalImagePath = imagePathArray.join('/');
    //  validate, process and normalize the requested oprations 
    var operationsArray = operationsPrefix.split(',');
    var normalizedOperations = {};
    operationsArray.forEach(operation => {
        var operationKV = operation.split("=");
        switch (operationKV[0]) {
            case 'format': 
                var SUPPORTED_FORMATS = ['auto', 'jpeg', 'webp', 'avif', 'png', 'svg', 'gif'];
                if (operationKV[1] && SUPPORTED_FORMATS.includes(operationKV[1])) {
                    if (operationKV[1] === 'auto') {
                        operationKV[1] = 'jpeg';
                        if (request.headers['accept']) {
                            if (request.headers['accept'].value.includes("avif")) {
                                operationKV[1] = 'avif';
                            } else if (request.headers['accept'].value.includes("webp")) {
                                operationKV[1] = 'webp';
                            } 
                        }
                    }
                    normalizedOperations['format'] = operationKV[1];
                }
                break;
        case 'width':
            if (operationKV[1]) {
                var width = parseInt(operationKV[1]);
                if (width < 0) width = width * -1;
                if (width > 4000) width = 4000;
                normalizedOperations['width'] = width.toString();
            }
            break;
        case 'height':
            if (operationKV[1]) {
                var height = parseInt(operationKV[1]);
                if (height < 0) height = height * -1;
                if (height > 4000) height = 4000;
                normalizedOperations['height'] = height.toString();
            }
            break;
        default: break;
      }
    });
    //if no valid operations found, redirect to original image on S3, otherwise rewrite the path to normalized version
    if (Object.keys(normalizedOperations).length > 0) {
        // put them in order
        var normalizedOperationsArray = [];
        if (normalizedOperations.format) normalizedOperationsArray.push('format='+normalizedOperations.format);
        if (normalizedOperations.width) normalizedOperationsArray.push('width='+normalizedOperations.width);
        if (normalizedOperations.height) normalizedOperationsArray.push('height='+normalizedOperations.height);
        request.uri =  '/' + normalizedOperationsArray.join(',') + '/' + originalImagePath;
        
        return request;
    } else return { 
        statusCode: 302, 
        statusDescription: 'Found', 
        headers: { "location": { "value": "https://"+request.headers['host'].value+'/'+originalImagePath } } 
    }
    

}
