'use strict';

var _ = require('underscore'),
    Q = require('q'),
    Class = require('class.extend'),
    VALID_EVENT_TYPES = [ 'viewer-request', 'origin-request', 'viewer-response', 'origin-response' ];

module.exports = Class.extend({

   init: function(serverless, opts) {
      this._serverless = serverless;
      this._provider = serverless ? serverless.getProvider('aws') : null;
      this._opts = opts;

      if (!this._provider) {
         throw new Error('This plugin must be used with AWS');
      }

      this.hooks = {
         'aws:package:finalize:mergeCustomProviderResources': this._onPackageCustomResources.bind(this),
         'before:deploy:finalize': this._onBeforeDeployFinalize.bind(this),
         'package:function:package': this._onFunctionPackage.bind(this),
      };

   },

   _onFunctionPackage: function() {
      this._serverless.cli.log('Function being packaged ...');
   },

   _onPackageCustomResources: function() {
      this._modifyTemplate();
   },

   _onBeforeDeployFinalize: function() {
      var cnt = this._pendingAssociations.length;

      if (cnt === 0) {
         return;
      }

      /**
       * Each entry in the this._pendingAssociations array looks like this:
       * {
       *    "fnLogicalName": "YourFnNameLambdaFunction",
       *    "distLogicalName": "WebsiteDistribution",
       *    "fnCurrentVersionOutputName": "YourFnNameLambdaFunctionQualifiedArn",
       *    "eventType": "origin-request",
       * }
       */

      this._serverless.cli.log(
         'Checking to see if ' + cnt +
         (cnt > 1 ? ' functions need ' : ' function needs ') +
         'to be associated to CloudFront'
      );

      return Q.all([ this._getFunctionsToAssociate(), this._getDistributionPhysicalIDs() ])
         .spread(this._updateDistributionsAsNecessary.bind(this));
   },

   _modifyTemplate: function() {
      var template = this._serverless.service.provider.compiledCloudFormationTemplate;

      this._modifyExecutionRole(template);
      this._modifyLambdaFunctions(this._serverless.service.functions, template);
   },

   _modifyExecutionRole: function(template) {
      var assumeRoleUpdated = false;

      if (!template.Resources || !template.Resources.IamRoleLambdaExecution) {
         this._serverless.cli.log('WARNING: no IAM role for Lambda execution found - can not modify assume role policy');
         return;
      }

      _.each(template.Resources.IamRoleLambdaExecution.Properties.AssumeRolePolicyDocument.Statement, function(stmt) {
         var svc = stmt.Principal.Service;

         if (stmt.Principal && svc && _.contains(svc, 'lambda.amazonaws.com') && !_.contains(svc, 'edgelambda.amazonaws.com')) {
            svc.push('edgelambda.amazonaws.com');
            assumeRoleUpdated = true;
            this._serverless.cli.log('Updated Lambda assume role policy to allow Lambda@Edge to assume the role');
         }
      }.bind(this));

      // Serverless creates a LogGroup by a specific name, and grants logs:CreateLogStream
      // and logs:PutLogEvents permissions to the function. However, on a replicated
      // function, AWS will name the log groups differently, so the Serverless-created
      // permissions will not work. Thus, we must give the function permission to create
      // log groups and streams, as well as put log events.
      //
      // Since we don't have control over the naming of the log group, we let this
      // function have permission to create and use a log group by any name.
      // See http://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/iam-identity-based-access-control-cwl.html
      template.Resources.IamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement.push({
         Effect: 'Allow',
         Action: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:DescribeLogStreams',
         ],
         Resource: 'arn:aws:logs:*:*:*',
      });

      if (!assumeRoleUpdated) {
         this._serverless.cli.log('WARNING: was unable to update the Lambda assume role policy to allow Lambda@Edge to assume the role');
      }
   },

   _modifyLambdaFunctions: function(functions, template) {
      var self = this;

      this._pendingAssociations = _.chain(functions)
         .reduce(function(memo, fnDef, fnName) {
            var distName, evtType, dist, distId;

            if (!fnDef.lambdaAtEdge) {
               return memo;
            }

            distId = fnDef.lambdaAtEdge.distributionID || null;
            distName = fnDef.lambdaAtEdge.distribution || null;
            evtType = fnDef.lambdaAtEdge.eventType;
            dist = template.Resources[distName];


            if (!_.contains(VALID_EVENT_TYPES, evtType)) {
               throw new Error('"' + evtType + '" is not a valid event type, must be one of: ' + VALID_EVENT_TYPES.join(', '));
            }

            if (!dist && !distId) {
               throw new Error('Could not find resource with logical name "' + distName + '" or there is no distributionID set');
            }

            if (!distName && distId) {
               throw new Error('Distribution ID "' + distId + '" requires a distribution to be set');
            }

            if (!distId && dist.Type !== 'AWS::CloudFront::Distribution') {
               throw new Error('Resource with logical name "' + distName + '" is not type AWS::CloudFront::Distribution');
            }

            memo.push({
               fnLogicalName: self._provider.naming.getLambdaLogicalId(fnName),
               distributionID: distId,
               distLogicalName: distName,
               fnCurrentVersionOutputName: self._provider.naming.getLambdaVersionOutputLogicalId(fnName),
               eventType: evtType,
            });

            return memo;
         }, [])
         .each(function(fn) {
            var fnProps = template.Resources[fn.fnLogicalName].Properties;

            if (fnProps && fnProps.Environment && fnProps.Environment.Variables) {
               self._serverless.cli.log(
                  'Removing ' +
                  _.size(fnProps.Environment.Variables) +
                  ' environment variables from function "' +
                  fn.fnLogicalName +
                  '" because Lambda@Edge does not support environment variables'
               );

               delete fnProps.Environment.Variables;

               if (_.isEmpty(fnProps.Environment)) {
                  delete fnProps.Environment;
               }
            }
         })
         .value();
   },

   _updateDistributionsAsNecessary: function(fns, dists) {
      return Q.all(_.map(dists, this._updateDistributionAsNecessary.bind(this, fns)));
   },

   _waitForDistributionDeployed: function(distPhysicalID, distLogicalName) {
      var self = this,
          cloudfront = new this._provider.sdk.CloudFront(this._provider.getCredentials()),
          firstDot = true,
          running = true;

      function dotPrinter() {
         if (running) {
            if (firstDot) {
               self._serverless.cli.log('Waiting for CloudFront distribution "' + distLogicalName + '" to be deployed');
               self._serverless.cli.log('This can take awhile.');
               firstDot = false;
            }
            self._serverless.cli.printDot();
            setTimeout(dotPrinter, 2000);
         }
      }

      setTimeout(dotPrinter, 1000);

      return Q.ninvoke(cloudfront, 'waitFor', 'distributionDeployed', { Id: distPhysicalID })
         .then(function(resp) {
            running = false;
            if (!firstDot) {
               // we have printed a dot, so clear the line
               this._serverless.cli.consoleLog('');
            }
            this._serverless.cli.log('Distribution "' + distLogicalName + '" is now in "' + resp.Distribution.Status + '" state');
         }.bind(this));
   },

   _updateDistributionAsNecessary: function(fns, distID, distName) {
      var self = this;

      return this._waitForDistributionDeployed(distID, distName)
         .then(function() {
            return self._provider.request('CloudFront', 'getDistribution', { Id: distID });
         })
         .then(function(resp) {
            var config = resp.Distribution.DistributionConfig,
                changed = self._modifyDistributionConfigIfNeeded(config, fns[distName]),
                updateParams = { Id: distID, DistributionConfig: config, IfMatch: resp.ETag };

            if (changed) {
               self._serverless.cli.log('Updating distribution "' + distName + '" because we updated Lambda@Edge associations on it');
               return self._provider.request('CloudFront', 'updateDistribution', updateParams)
                  .then(function() {
                     return self._waitForDistributionDeployed(distID, distName);
                  })
                  .then(function() {
                     self._serverless.cli.log('Done updating distribution "' + distName + '"');
                  });
            }

            self._serverless.cli.log(
               'The distribution is already configured with the current versions of each Lambda@Edge function it needs'
            );
         });
   },

   _modifyDistributionConfigIfNeeded: function(distConfig, fns) {
      var changed = this._associateFunctionsToBehavior(distConfig.DefaultCacheBehavior, fns);

      _.each(distConfig.CacheBehaviors.Items, function(beh) {
         var behaviorChanged = this._associateFunctionsToBehavior(beh, fns);

         changed = changed || behaviorChanged;
      }.bind(this));

      return changed;
   },

   _associateFunctionsToBehavior: function(beh, fns) {
      var changed = false;

      _.each(fns, function(fn) {
         var existing = _.findWhere(beh.LambdaFunctionAssociations.Items, { EventType: fn.eventType });

         if (!existing) {
            this._serverless.cli.log('Adding new Lamba@Edge association for ' + fn.eventType + ': ' + fn.fnARN);
            beh.LambdaFunctionAssociations.Items.push({
               EventType: fn.eventType,
               LambdaFunctionARN: fn.fnARN,
            });
            changed = true;
         } else if (existing.LambdaFunctionARN !== fn.fnARN) {
            this._serverless.cli.log('Updating ' + fn.eventType + ' to use ' + fn.fnARN + ' (was ' + existing.LambdaFunctionARN + ')');
            existing.LambdaFunctionARN = fn.fnARN;
            changed = true;
         }
      }.bind(this));

      if (changed) {
         beh.LambdaFunctionAssociations.Quantity = beh.LambdaFunctionAssociations.Items.length;
      }

      return changed;
   },

   _getFunctionsToAssociate: function() {
      var stackName = this._provider.naming.getStackName();

      return this._provider.request('CloudFormation', 'describeStacks', { StackName: stackName })
         .then(function(resp) {
            var stack = _.findWhere(resp.Stacks, { StackName: stackName });

            if (!stack) {
               throw new Error('CloudFormation did not return a stack with name "' + stackName + '"');
            }

            return _.reduce(this._pendingAssociations, function(memo, pending) {
               var outputName = pending.fnCurrentVersionOutputName,
                   output = _.findWhere(stack.Outputs, { OutputKey: outputName });

               if (!output) {
                  throw new Error('Stack "' + stackName + '" did not have an output with name "' + outputName + '"');
               }

               if (!memo[pending.distLogicalName]) {
                  memo[pending.distLogicalName] = [];
               }

               memo[pending.distLogicalName].push({
                  eventType: pending.eventType,
                  fnARN: output.OutputValue,
               });

               return memo;
            }, {});
         }.bind(this));
   },

   _getDistributionPhysicalIDs: function() {
      var stackName = this._provider.naming.getStackName(),
          existingDistIds;

      existingDistIds = _.reduce(this._pendingAssociations, function(memo, pending) {
         if (pending.distributionID) {
            memo[pending.distLogicalName] = pending.distributionID;
         }
         return memo;
      }, {});

      // If they all had distributionIDs, no reason to query CloudFormation
      if (_.size(existingDistIds) === this._pendingAssociations.length) {
         return Q.resolve(existingDistIds);
      }

      return this._provider.request('CloudFormation', 'describeStackResources', { StackName: stackName })
         .then(function(resp) {
            return _.reduce(this._pendingAssociations, function(memo, pending) {
               var resource = _.findWhere(resp.StackResources, { LogicalResourceId: pending.distLogicalName });

               if (!resource) {
                  throw new Error('Stack "' + stackName + '" did not have a resource with logical name "' + pending.distLogicalName + '"');
               }

               memo[pending.distLogicalName] = resource.PhysicalResourceId;

               return memo;
            }, {});
         }.bind(this));
   },

});
