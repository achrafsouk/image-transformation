#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageTransformationStack } from '../lib/image-transformation-stack';


const app = new cdk.App();
new ImageTransformationStack(app, 'imageTransformationStack', {

});

