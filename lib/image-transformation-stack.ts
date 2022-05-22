import { Stack, StackProps, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_lambda as lambda, aws_iam as iam, Duration, CfnOutput, aws_logs as logs} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MyCustomResource } from './my-custom-resource';

// The number of days we want to keep transformed images on S3 useing lifecycle policies
const S3_OBJECT_LIFECYCLE_DURATION = 1; 
const TRANSFORMED_IMAGE_PREFIX = 'transformed'
// optional prefix in destination S3 bucket
const S3_DESTINATION_PREFIX = 'images/rio/';
// cache TTL of transformed images
const TRANSFORMED_IMAGE_TTL = '31622400';


export class ImageTransformationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    
    // secret key between CloudFront and Lambda URL for access control
    const SECRET_KEY = this.node.addr;
    // Create the image S3 bucket
    const imageBucket = new s3.Bucket(this, 's3-image-storage', {
      lifecycleRules: [
          {
            prefix: TRANSFORMED_IMAGE_PREFIX+'/',
            expiration: Duration.days(S3_OBJECT_LIFECYCLE_DURATION),
          },
        ],
    });
    // Add a sample image
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./image-sample')],
      destinationBucket: imageBucket,
      destinationKeyPrefix: S3_DESTINATION_PREFIX, // optional prefix in destination bucket
    });

    // Creating Lambda URL for image processing using Sharp library
    const imageProcessing = new lambda.Function(this, 'image-transformation', {
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(5),
      memorySize: 1500,
      environment: {
        bucketName: imageBucket.bucketName,
        transformedImagePrefix: TRANSFORMED_IMAGE_PREFIX,
        transformedImageTTL: TRANSFORMED_IMAGE_TTL,
        secretKey: SECRET_KEY,
      },
      logRetention: logs.RetentionDays.ONE_DAY,
    });

    const imageProcessingURL = imageProcessing.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Add IAM permissions to the Lambda function to be able to access the image bucket
    const s3BucketReadWritePolicy = new iam.PolicyStatement({
      actions: ['s3:*Object'],
      resources: ['arn:aws:s3:::'+imageBucket.bucketName+'/*'],
    });
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        statements: [s3BucketReadWritePolicy],
      }),
    );
    
    // Leverage a custom resource to get the hostname of the LambdaURL
    const imageProcessingHelper = new MyCustomResource(this, 'DemoResource', {
      Url: imageProcessingURL.url,
    });

    // Create a CloudFront Function for url rewrites
    const urlRewriteFunction = new cloudfront.Function(this, 'urlRewrite', {
      code: cloudfront.FunctionCode.fromFile({filePath: 'functions/url-rewrite/index.js',}),
      functionName: `urlRewriteFunction${this.node.addr}`, 
    });
    // CReate a CloudFront cache behaviour dedicated for image optimization
    // Create a CloudFront distribution with default behaviour pointing to the S3 bucket

    const imageDelivery = new cloudfront.Distribution(this, 'imageDelivery', {
      comment: 'image optimization',
      defaultBehavior: {
        origin: new origins.S3Origin(imageBucket)
      },
      additionalBehaviors: {
        '*/images/*': {
          origin: new origins.OriginGroup ({
            primaryOrigin: new origins.S3Origin(imageBucket, {
              originShieldRegion: Stack.of(this).region,
              originPath: '/' + TRANSFORMED_IMAGE_PREFIX,
            }),
            fallbackOrigin: new origins.HttpOrigin(imageProcessingHelper.hostname, {
              originShieldRegion: Stack.of(this).region,
              customHeaders: {
                'x-origin-secret-header': SECRET_KEY,
              },
            }), 
            fallbackStatusCodes: [403],
          }),
          functionAssociations: [{
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: urlRewriteFunction,
          }]
        },
      },
    });
    // Test url
    new CfnOutput(this, 'URL', {
      description: 'You can use this url to test image resizing',
      value: 'https://'+imageDelivery.distributionDomainName+'/'+S3_DESTINATION_PREFIX+'1.jpeg'
    });
    // S3 bucket name
    new CfnOutput(this, 'Bucket', {
      description: 'You can drop additional files, images to this bucket',
      value: imageBucket.bucketName
    });

  }
}

