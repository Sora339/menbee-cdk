#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DockerImageDeploymentStack } from '../lib/docker-image-deployment';

const app = new cdk.App();

new DockerImageDeploymentStack(app, 'MenbeeSchedulerStack', {
  domainName: 'menbee-scheduler.com',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1', // 東京リージョン
  },
});