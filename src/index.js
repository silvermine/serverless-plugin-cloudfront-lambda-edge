'use strict';

var _ = require('underscore'),
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
         'aws:package:finalize:mergeCustomProviderResources': this._modifyTemplate.bind(this),
      };

   },

   _modifyTemplate: function() {
      var template = this._serverless.service.provider.compiledCloudFormationTemplate;

      this._modifyExecutionRole(template);
      this._modifyLambdaFunctionsAndDistributions(this._serverless.service.functions, template);
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

   _modifyLambdaFunctionsAndDistributions: function(functions, template) {
      var self = this;

      _.chain(functions)
         .pick(_.property('lambdaAtEdge')) // `pick` is used like `filter`, but for objects
         .each(function(fnDef, fnName) {
            var outputName = self._provider.naming.getLambdaVersionOutputLogicalId(fnName),
                fnLogicalName = self._provider.naming.getLambdaLogicalId(fnName),
                distName = fnDef.lambdaAtEdge.distribution,
                fnProps = template.Resources[fnLogicalName].Properties,
                evtType = fnDef.lambdaAtEdge.eventType,
                output = template.Outputs[outputName],
                dist = template.Resources[distName],
                distConfig, fnAssociations, versionLogicalID;

            if (!_.contains(VALID_EVENT_TYPES, evtType)) {
               throw new Error('"' + evtType + '" is not a valid event type, must be one of: ' + VALID_EVENT_TYPES.join(', '));
            }

            if (!dist) {
               throw new Error('Could not find resource with logical name "' + distName + '"');
            }

            if (dist.Type !== 'AWS::CloudFront::Distribution') {
               throw new Error('Resource with logical name "' + distName + '" is not type AWS::CloudFront::Distribution');
            }

            distConfig = dist.Properties.DistributionConfig;
            fnAssociations = distConfig.DefaultCacheBehavior.LambdaFunctionAssociations;
            versionLogicalID = (output ? output.Value.Ref : null);

            if (!versionLogicalID) {
               throw new Error('Could not find output by name of "' + outputName + '" or value from it to use version ARN');
            }

            if (fnProps && fnProps.Environment && fnProps.Environment.Variables) {
               self._serverless.cli.log(
                  'Removing ' +
                  _.size(fnProps.Environment.Variables) +
                  ' environment variables from function "' +
                  fnLogicalName +
                  '" because Lambda@Edge does not support environment variables'
               );

               delete fnProps.Environment.Variables;

               if (_.isEmpty(fnProps.Environment)) {
                  delete fnProps.Environment;
               }
            }

            if (!_.isArray(fnAssociations)) {
               fnAssociations = distConfig.DefaultCacheBehavior.LambdaFunctionAssociations = [];
            }

            fnAssociations.push({
               EventType: evtType,
               LambdaFunctionARN: { Ref: versionLogicalID },
            });

            self._serverless.cli.log(
               'Added "' + evtType + '" Lambda@Edge association for version "' +
               versionLogicalID + '" to distribution "' + distName + '"'
            );
         });
   },

});
