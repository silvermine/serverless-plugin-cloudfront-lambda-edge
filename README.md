# Serverless Plugin: Support CloudFront Lambda@Edge

[![Build Status](https://travis-ci.org/silvermine/serverless-plugin-cloudfront-lambda-edge.png?branch=master)](https://travis-ci.org/silvermine/serverless-plugin-cloudfront-lambda-edge)
[![Coverage Status](https://coveralls.io/repos/github/silvermine/serverless-plugin-cloudfront-lambda-edge/badge.svg?branch=master)](https://coveralls.io/github/silvermine/serverless-plugin-cloudfront-lambda-edge?branch=master)
[![Dependency Status](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge.png)](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge)
[![Dev Dependency Status](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge/dev-status.png)](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge#info=devDependencies&view=table)


## What is it?

This is a plugin for the Serverless framework that adds support for associating a Lambda
function with a CloudFront distribution to take advantage of the Lambda@Edge features of
CloudFront.

Even though CloudFormation added support for Lambda@Edge via its
[`LambdaFunctionAssociations`][FnAssoc] config object, it would be difficult to define a
CloudFront distribution in your serverless.yml file's resources that links to one of the
functions that you're deploying with Serverless.

Why? Because the [`LambdaFunctionAssociations`][FnAssoc] array needs a reference to the
Lambda function's _version_ (`AWS::Lambda::Version` resource), not just the function
itself. (The documentation for CloudFormation says "You must specify the ARN of a function
version; you can't specify a Lambda alias or $LATEST."). Serverless creates the version
automatically for you, but the logical ID for it is seemingly random. You'd need that
logical ID to use a `Ref` in your CloudFormation template for the function association.

This plugin hides all that for you - it uses other features in Serverless to be able to
programmatically determine the function's logical ID and build the reference for you in
the LambdaFunctionAssociations object. It directly modifies your CloudFormation template
before the stack is ever deployed, so that CloudFormation does the heavy lifting for you.
This 2.0 version of the plugin is thus much faster and easier to use than the 1.0 version
(which existed before CloudFormation supported Lambda@Edge).


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

Also in your `serverless.yml` file, you will modify your function definitions to include a
`lambdaAtEdge` property. That property can be an object if you are associating the
function with only a single distribution (or single cache behavior). Or, if you want the
same function associated with multiple distributions or cache behaviors, the property
value can be an array of objects. Whether you define a single object or an array of
objects, the objects all have the same fields, each of which is explained here:

   * **`distribution`** (required): the logical name used in your `Resources` section to
     define the CloudFront distribution.
   * **`eventType`** (required): a string, one of the four Lambda@Edge event types:
      * viewer-request
      * origin-request
      * viewer-response
      * origin-response
   * **`pathPattern`** (optional): a string, the path pattern of one of the cache
     behaviors in the specified distribution if you want this function to be associated
     with a specific cache behavior. If the path pattern is not defined here, the function
     will be associated with the default cache behavior for the specified distribution.

You can also apply global properties by adding the `lambdaAtEdge` property to your
`custom` section of your `serverless.yml`. **Note:** This section currently only supports
the follow option:

   * **`retain`** (optional): a boolean (default `false`). If you set this value to
     `true`, it will set the [DeletionPolicy][DeletionPolicy] of the function resource to
     `Retain`. This can be used to avoid the currently-inevitable [CloudFormation stack
     deletion failure][ReplicaDeleteFail]. There are at least [two schools of
     thought][HandlingCFNFailure] on how to handle this issue. Hopefully AWS will have
     this fixed soon. Use at your own discretion.

For example:

```yml
functions:
   directoryRootOriginRequestRewriter:
      name: '${self:custom.objectPrefix}-directory-root-origin-request-rewriter'
      handler: src/DirectoryRootOriginRequestRewriteHandler.handler
      memorySize: 128
      timeout: 1
      lambdaAtEdge:
         distribution: 'WebsiteDistribution'
         eventType: 'origin-request'
```

Or:

```yml
custom:
   lambdaAtEdge:
      retain: true

functions:
   someImageHandlingFunction:
      name: '${self:custom.objectPrefix}-image-handling'
      handler: src/ImageSomethingHandler.handler
      memorySize: 128
      timeout: 1
      lambdaAtEdge:
         distribution: 'WebsiteDistribution'
         eventType: 'viewer-request'
         # This must match a path pattern in a cache behavior of the distribution:
         pathPattern: 'images/*.jpg'
```

Or:

```yml
functions:
   someFunction:
      name: '${self:custom.objectPrefix}'
      handler: src/SomethingHandler.handler
      memorySize: 128
      timeout: 1
      lambdaAtEdge:
         -
            distribution: 'WebsiteDistribution'
            eventType: 'viewer-response'
            # This must match a path pattern in a cache behavior of the distribution:
            pathPattern: 'images/*.jpg'
         -
            distribution: 'OtherDistribution'
            eventType: 'viewer-response'
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
[FnAssoc]: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-cloudfront-distribution-cachebehavior.html#cfn-cloudfront-distribution-cachebehavior-lambdafunctionassociations
[DeletionPolicy]: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html
[ReplicaDeleteFail]: https://forums.aws.amazon.com/thread.jspa?threadID=260242&tstart=0
[HandlingCFNFailure]: https://github.com/silvermine/serverless-plugin-cloudfront-lambda-edge/pull/19
