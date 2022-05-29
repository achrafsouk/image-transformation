import { Stack, StackProps, CfnParameter, CfnCondition, Fn, RemovalPolicy, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_lambda as lambda, aws_iam as iam, Duration, CfnOutput, aws_logs as logs} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MyCustomResource } from './my-custom-resource';
import { createHash } from 'crypto';

// Region to Origin Shield mapping based on latency. to be updated when new Regional Edge Caches are added to CloudFront.
const ORIGIN_SHIELD_MAPPING = new Map([['af-south-1', 'eu-west-2'], [ 'ap-east-1' ,'ap-northeast-2'], [ 'ap-northeast-1', 'ap-northeast-1'], [
  'ap-northeast-2', 'ap-northeast-2'], [ 'ap-northeast-3', 'ap-northeast-1'], [ 'ap-south-1', 'ap-south-1'], [ 'ap-southeast-1','ap-southeast-1'], [ 
  'ap-southeast-2', 'ap-southeast-2'], [ 'ca-central-1', 'us-east-1'], [ 'eu-central-1', 'eu-central-1'], [ 'eu-north-1','eu-central-1'], [
  'eu-south-1','eu-central-1'], [ 'eu-west-1', 'eu-west-1'], [ 'eu-west-2', 'eu-west-2'], [ 'eu-west-3', 'eu-west-2'], [ 'me-south-1', 'ap-south-1'], [
  'sa-east-1', 'sa-east-1'], [ 'us-east-1', 'us-east-1'], [ 'us-east-2','us-east-2'], [ 'us-west-1', 'us-west-1'], [ 'us-west-2', 'us-west-2']] );

// Parameters of the stack
var S3_OBJECT_EXPIRATION_DURATION = '90'; 
var TRANSFORMED_IMAGE_PREFIX = 'transformed'
var TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';
var ORIGIN_SHIELD_ENABLED = 'true';
var STORE_TRANSFORMED_IMAGES = 'true';
var LAMBDA_MEMORY = '1500';
var LAMBDA_TIMEOUT = '60';
var LOG_TIMING = 'true';
var S3_REMOVE_EMPTY_AFTER_CDK_DESTROY = 'false';
var ORIGIN_SHIELD_REGION = ORIGIN_SHIELD_MAPPING.get(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || '');
var S3_DESTINATION_PREFIX = 'images/rio/';


export class ImageTransformationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Change stack parameters based on provded context
    S3_OBJECT_EXPIRATION_DURATION = this.node.tryGetContext('S3_OBJECT_EXPIRATION_DURATION') || S3_OBJECT_EXPIRATION_DURATION; 
    TRANSFORMED_IMAGE_PREFIX = this.node.tryGetContext('TRANSFORMED_IMAGE_PREFIX') || TRANSFORMED_IMAGE_PREFIX;
    TRANSFORMED_IMAGE_CACHE_TTL = this.node.tryGetContext('TRANSFORMED_IMAGE_CACHE_TTL') || TRANSFORMED_IMAGE_CACHE_TTL;
    ORIGIN_SHIELD_ENABLED = this.node.tryGetContext('ORIGIN_SHIELD_ENABLED') || ORIGIN_SHIELD_ENABLED;
    STORE_TRANSFORMED_IMAGES = this.node.tryGetContext('STORE_TRANSFORMED_IMAGES') || STORE_TRANSFORMED_IMAGES;
    LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
    LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
    LOG_TIMING = this.node.tryGetContext('LOG_TIMING') || LOG_TIMING;
    S3_REMOVE_EMPTY_AFTER_CDK_DESTROY = this.node.tryGetContext('S3_REMOVE_EMPTY_AFTER_CDK_DESTROY') || S3_REMOVE_EMPTY_AFTER_CDK_DESTROY;
    ORIGIN_SHIELD_REGION = this.node.tryGetContext('ORIGIN_SHIELD_REGION') || ORIGIN_SHIELD_REGION;
    S3_DESTINATION_PREFIX = this.node.tryGetContext('S3_DESTINATION_PREFIX') || S3_DESTINATION_PREFIX;

    // Create secret key to be used between CloudFront and Lambda URL for access control
    const SECRET_KEY = createHash('md5').update(this.node.addr).digest('hex') ;

    // Create the image S3 bucket
    var imageBucketOptions = {
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false, 
      lifecycleRules: [
          {
            prefix: TRANSFORMED_IMAGE_PREFIX+'/',
            expiration: Duration.days(parseInt(S3_OBJECT_EXPIRATION_DURATION)),
          },
        ],
    }
    if (S3_REMOVE_EMPTY_AFTER_CDK_DESTROY === 'true') {
      imageBucketOptions.removalPolicy = RemovalPolicy.DESTROY;
      imageBucketOptions.autoDeleteObjects = true;
    }
    const imageBucket = new s3.Bucket(this, 's3-image-storage', imageBucketOptions);
    // Add a sample image
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./image-sample')],
      destinationBucket: imageBucket,
      destinationKeyPrefix: S3_DESTINATION_PREFIX,
    });

    // Create Lambda URL for image processing
    const imageProcessing = new lambda.Function(this, 'image-transformation', {
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: {
        bucketName: imageBucket.bucketName,
        storeTransformedImages: STORE_TRANSFORMED_IMAGES,
        transformedImagePrefix: TRANSFORMED_IMAGE_PREFIX,
        transformedImageCacheTTL: TRANSFORMED_IMAGE_CACHE_TTL,
        secretKey: SECRET_KEY,
        logTiming: LOG_TIMING,
      },
      logRetention: logs.RetentionDays.ONE_DAY,
    });

    // Enable Lambda URL
    const imageProcessingURL = imageProcessing.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Add IAM permissions to the Lambda function to be able to access the image bucket
    var allowedActions = ['s3:GetObject'];
    if (STORE_TRANSFORMED_IMAGES === 'true') allowedActions.push('s3:PutObject');
    const s3BucketReadWritePolicy = new iam.PolicyStatement({
      actions: allowedActions,
      resources: ['arn:aws:s3:::'+imageBucket.bucketName+'/*'],
    });

    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        statements: [s3BucketReadWritePolicy],
      }),
    );
    
    // Leverage a custom resource to get the hostname of the LambdaURL
    const imageProcessingHelper = new MyCustomResource(this, 'customResource', {
      Url: imageProcessingURL.url,
    });

    // Create a CloudFront Function for url rewrites
    const urlRewriteFunction = new cloudfront.Function(this, 'urlRewrite', {
      code: cloudfront.FunctionCode.fromFile({filePath: 'functions/url-rewrite/index.js',}),
      functionName: `urlRewriteFunction${this.node.addr}`, 
    });

    // Creating a custom response headers policy. CORS allowed for all origins.
    const myResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy${this.node.addr}`, {
      responseHeadersPolicyName: 'ImageResponsePolicy',
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET'],
        accessControlAllowOrigins: ['*'],
        accessControlMaxAge: Duration.seconds(600),
        originOverride: false,
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'X-AWS-Image-Optimization-Solution', value: 'v1.0', override: true },
        ],
      },
      securityHeadersBehavior: {
        // contentSecurityPolicy: { contentSecurityPolicy: 'default-src https:;', override: true },
        //contentTypeOptions: { override: true },
        // frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        // referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.seconds(63072000), includeSubdomains: true, override: true },
        // xssProtection: { protection: true, modeBlock: true, reportUri: 'https://example.com/csp-report', override: true },
      },
    });    

    // Create a CloudFront cache behaviour dedicated for image optimization, based on configured
    // architecture (with or without storing transformed images)
    // Create a CloudFront distribution with default behaviour pointing to the S3 bucket
    var originShieldRegion;
    if (ORIGIN_SHIELD_ENABLED === 'true') originShieldRegion = ORIGIN_SHIELD_MAPPING.get(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || '') ;

    var ImageOrigin;
    if (STORE_TRANSFORMED_IMAGES === 'true') {
      ImageOrigin = new origins.OriginGroup ({
        primaryOrigin: new origins.S3Origin(imageBucket, {
          originShieldRegion: originShieldRegion,
          originPath: '/' + TRANSFORMED_IMAGE_PREFIX,
        }),
        fallbackOrigin: new origins.HttpOrigin(imageProcessingHelper.hostname, {
          originShieldRegion: originShieldRegion,
          customHeaders: {
            'x-origin-secret-header': SECRET_KEY,
          },
        }), 
        fallbackStatusCodes: [403],
      });
    } else {
      ImageOrigin = new origins.HttpOrigin(imageProcessingHelper.hostname, {
        originShieldRegion: originShieldRegion,
        customHeaders: {
          'x-origin-secret-header': SECRET_KEY,
        },
      });
    }
    const imageDelivery = new cloudfront.Distribution(this, 'imageDelivery', {
      comment: 'image optimization',
      defaultBehavior: {
        origin: new origins.S3Origin(imageBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '*/images/*': {
          origin: ImageOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          functionAssociations: [{
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: urlRewriteFunction,
          }]
        },
      },
    });

    // Test urls
    new CfnOutput(this, 'TransformedImageUrl1', {
      description: 'Exmaple of transformed image url',
      value: 'https://'+imageDelivery.distributionDomainName+'/format=avif,quality=40/'+S3_DESTINATION_PREFIX+'1.jpeg'
    });
    new CfnOutput(this, 'TransformedImageUrl2', {
      description: 'Exmaple of transformed image url',
      value: 'https://'+imageDelivery.distributionDomainName+'/format=auto,width=300/'+S3_DESTINATION_PREFIX+'1.jpeg'
    });
    new CfnOutput(this, 'OriginalImageURL', {
      description: 'URL of an original image',
      value: 'https://'+imageDelivery.distributionDomainName+'/'+S3_DESTINATION_PREFIX+'1.jpeg'
    });

    // S3 bucket name
    new CfnOutput(this, 'Bucket', {
      description: 'You can drop additional files, images to this bucket',
      value: imageBucket.bucketName
    });

  }
}
