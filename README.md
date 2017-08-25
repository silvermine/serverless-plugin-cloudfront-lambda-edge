# Serverless Plugin: Support CloudFront Lambda@Edge

[![Build Status](https://travis-ci.org/silvermine/serverless-plugin-cloudfront-lambda-edge.png?branch=master)](https://travis-ci.org/silvermine/serverless-plugin-cloudfront-lambda-edge)
[![Coverage Status](https://coveralls.io/repos/github/silvermine/serverless-plugin-cloudfront-lambda-edge/badge.svg?branch=master)](https://coveralls.io/github/silvermine/serverless-plugin-cloudfront-lambda-edge?branch=master)
[![Dependency Status](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge.png)](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge)
[![Dev Dependency Status](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge/dev-status.png)](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge#info=devDependencies&view=table)


## What is it?

This is a plugin for the Serverless framework that adds support for associating a Lambda
function with a CloudFront distribution to take advantage of the new Lambda@Edge features
of CloudFront.


## How do I use it?

There are three steps:

### Install the Plugin as a Development Dependency

```bash
npm install --save-dev --save-exact serverless-plugin-cloudfront-lambda-edge
```

### Telling Serverless to Use the Plugin

Simply add this plugin to the list of plugins in your `serverless.yml` file:

```yml
plugins:
   - serverless-plugin-cloudfront-lambda-edge
```

### Configuring Functions to Associate With CloudFront Distributions

Also in your `serverless.yml` file, you will modify your function definitions
to include a `lambdaAtEdge` property. That object will contain two key/value
pairs: `distribution` and `eventType`.

The `distribution` is the logical name used in your `Resources` section to
define the CloudFront distribution.

The `eventType` is one of the four Lambda@Edge event types:

   * viewer-request
   * origin-request
   * viewer-response
   * origin-response

For example:

```yml
functions:
   directoryRootOriginRequestRewriter:
      name: '${self:custom.objectPrefix}-origin-request'
      handler: src/DirectoryRootOriginRequestRewriteHandler.handler
      memorySize: 128
      timeout: 1
      lambdaAtEdge:
         distribution: 'WebsiteDistribution'
         eventType: 'origin-request'
```


## Example CloudFront Static Site Serverless Config

Here is an example of a `serverless.yml` file that configures an S3 bucket with a
CloudFront distribution and a Lambda@Edge function:

```yml
service: static-site

custom:
   defaultRegion: us-east-1
   defaultEnvironmentGroup: dev
   region: ${opt:region, self:custom.defaultRegion}
   stage: ${opt:stage, env:USER}
   objectPrefix: '${self:service}-${self:custom.stage}'

plugins:
   - serverless-plugin-cloudfront-lambda-edge

package:
   exclude:
      - 'node_modules/**'

provider:
   name: aws
   runtime: nodejs6.10 # Because this runs on CloudFront (lambda@edge) it must be 6.10
   region: ${self:custom.region}
   stage: ${self:custom.stage}
   # Note that Lambda@Edge does not actually support environment variables for lambda
   # functions, but the plugin will strip the environment variables from any function
   # that has edge configuration on it
   environment:
      SLS_SVC_NAME: ${self:service}
      SLS_STAGE: ${self:custom.stage}

functions:
   directoryRootOriginRequestRewriter:
      name: '${self:custom.objectPrefix}-origin-request'
      handler: src/DirectoryRootOriginRequestRewriteHandler.handler
      memorySize: 128
      timeout: 1
      lambdaAtEdge:
         distribution: 'WebsiteDistribution'
         eventType: 'origin-request'

resources:
   Resources:
      WebsiteBucket:
         Type: 'AWS::S3::Bucket'
         Properties:
            BucketName: '${self:custom.objectPrefix}'
            AccessControl: 'PublicRead'
            WebsiteConfiguration:
               IndexDocument: 'index.html'
               ErrorDocument: 'error.html'
      WebsiteDistribution:
         Type: 'AWS::CloudFront::Distribution'
         Properties:
            DistributionConfig:
               DefaultCacheBehavior:
                  TargetOriginId: 'WebsiteBucketOrigin'
                  ViewerProtocolPolicy: 'redirect-to-https'
                  DefaultTTL: 600 # ten minutes
                  MaxTTL: 600 # ten minutes
                  Compress: true
                  ForwardedValues:
                     QueryString: false
                     Cookies:
                        Forward: 'none'
               DefaultRootObject: 'index.html'
               Enabled: true
               PriceClass: 'PriceClass_100'
               HttpVersion: 'http2'
               ViewerCertificate:
                  CloudFrontDefaultCertificate: true
               Origins:
                  -
                     Id: 'WebsiteBucketOrigin'
                     DomainName: { 'Fn::GetAtt': [ 'WebsiteBucket', 'DomainName' ] }
                     S3OriginConfig: {}
```

And here is an example function that would go with this Serverless template:

```js
'use strict';

module.exports = {

   // invoked by CloudFront (origin requests)
   handler: function(evt, context, cb) {
      var req = evt.Records[0].cf.request;

      if (req.uri && req.uri.length && req.uri.substring(req.uri.length - 1) === '/') {
         console.log('changing "%s" to "%s"', req.uri, req.uri + 'index.html');
         req.uri = req.uri + 'index.html';
      }

      cb(null, req);
   },

};
```


## How do I contribute?


We genuinely appreciate external contributions. See [our extensive
documentation][contributing] on how to contribute.


## License

This software is released under the MIT license. See [the license file](LICENSE) for more
details.


[contributing]: https://github.com/silvermine/silvermine-info#contributing
