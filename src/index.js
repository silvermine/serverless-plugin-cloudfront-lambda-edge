'use strict';

var _ = require('underscore'),
    Class = require('class.extend'),
    AdmZip = require('adm-zip'),
    path = require('path'),
    VALID_EVENT_TYPES = [ 'viewer-request', 'origin-request', 'viewer-response', 'origin-response' ];

module.exports = Class.extend({

   init: function(serverless, opts) {
      this._serverless = serverless;
      this._provider = serverless ? serverless.getProvider('aws') : null;
      this._opts = opts;
      this._custom = serverless.service ? serverless.service.custom : null;

      if (!this._provider) {
         throw new Error('This plugin must be used with AWS');
      }

      this._configureSchema(serverless.configSchemaHandler);

      this.hooks = {
         'aws:package:finalize:mergeCustomProviderResources': this._modifyTemplate.bind(this),
         'after:package:createDeploymentArtifacts': this._injectEnvVars.bind(this),
      };
   },

   _injectEnvVars: function() {

      const targetFunctions = this._getFunctionsToInjectVarsInto(this._serverless.service.functions);

      _.chain(targetFunctions)
         .pairs()
         .each(this._modifyFunctionPackageContents.bind(this));
   },

   _getFunctionsToInjectVarsInto: function(functiondefs) {
      return _.chain(functiondefs)
         .pairs()
         .filter(function([ functionName, functiondef ]) {
            const lambdaAtEdgeConfig = _.get(functiondef, 'lambdaAtEdge', {});

            let shouldInjectEnvVar = false;


            if (_.isArray(lambdaAtEdgeConfig)) {
               shouldInjectEnvVar = _.some(lambdaAtEdgeConfig, function(lambdaAtEdgeConfigItem) {
                  return _.get(lambdaAtEdgeConfigItem, 'injectEnv', false);
               });
            } else {
               shouldInjectEnvVar = _.get(lambdaAtEdgeConfig, 'injectEnv', false);
            }

            if (shouldInjectEnvVar && !_.get(this._serverless, [ 'service', 'provider', 'runtime' ], 'unknown').includes('nodejs')) {
               this._serverless.cli.log(
                  'WARNING: failed to inject env vars into lambda@edge function ' + functionName + '. Runtime must be nodejs.'
               );
               return false;
            }

            return shouldInjectEnvVar;
         }.bind(this))
         .object()
         .value();
   },

   _modifyFunctionPackageContents: function([ functionName, functionDef ]) {
      const targetPackage = _.get(functionDef, [ 'package', 'artifact' ], false) || this._serverless.service.package.artifact;

      const serviceDir = this._serverless.serviceDir;

      // Make sure the zip path is always prepended with the service directory
      const zipPath = targetPackage.startsWith(serviceDir) ?
         targetPackage :
         path.join(serviceDir, targetPackage);

      // Load zip file from resource path
      const zip = new AdmZip(zipPath);

      const file = functionDef.handler.split('.')[0] + '.js';

      const fileContents = zip.readAsText(file);

      // Loads environment for file
      const envVars = this._getEnvForFunc();

      if (_.isEmpty(envVars)) {
         this._serverless.cli.log('WARNING: No env vars to inject into ' + functionName);
         return;
      }

      this._serverless.cli.log('Injecting ' + _.size(envVars) + ' directly into the code for ' + functionName);

      const envData = this._envVarsToWriteableFormat(envVars);

      zip.addFile(file, Buffer.from(envData + fileContents, 'utf8'));
      zip.writeZip(zipPath);
   },

   _getEnvForFunc: function() {
      return this._serverless.service.provider.environment || {};
   },

   _envVarsToWriteableFormat(vars) {
      const envVarCode = _.chain(vars)
         .pairs()
         .map(function([ varName, varValue ]) {
            return 'process.env[\'' + varName + '\'] = ' + varValue + ';';
         })
         .value()
         .join('\n') + '\n';

      return 'var process={};\nprocess.env={};\n' + envVarCode;

   },

   _configureSchema: function(handler) {
      if (!handler || !_.isFunction(handler.defineCustomProperties) || !_.isFunction(handler.defineFunctionProperties)) {
         return;
      }

      handler.defineCustomProperties({
         type: 'object',
         properties: {
            'lambdaAtEdge': {
               type: 'object',
               properties: {
                  retain: { type: 'boolean' },
               },
            },
         },
      });

      const functionPropertySchema = {
         type: 'object',
         properties: {
            distribution: { type: 'string' },
            eventType: { enum: VALID_EVENT_TYPES },
            pathPattern: { type: 'string' },
            injectEnv: { type: 'boolean' },
         },
         required: [ 'distribution', 'eventType' ],
      };

      handler.defineFunctionProperties('aws', {
         properties: {
            'lambdaAtEdge': {
               oneOf: [
                  {
                     type: 'array',
                     items: functionPropertySchema,
                  },
                  functionPropertySchema,
               ],
            },
         },
      });
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
      _.chain(functions)
         .pick(_.property('lambdaAtEdge')) // `pick` is used like `filter`, but for objects
         .each(function(fnDef, fnName) {
            var lambdaAtEdge = fnDef.lambdaAtEdge;

            if (_.isArray(lambdaAtEdge)) {
               _.each(lambdaAtEdge, this._handleSingleFunctionAssociation.bind(this, template, fnDef, fnName));
            } else {
               this._handleSingleFunctionAssociation(template, fnDef, fnName, lambdaAtEdge);
            }
         }.bind(this));
   },

   _handleSingleFunctionAssociation: function(template, fnDef, fnName, lambdaAtEdge) {
      var fnLogicalName = this._provider.naming.getLambdaLogicalId(fnName),
          pathPattern = lambdaAtEdge.pathPattern,
          outputName = this._provider.naming.getLambdaVersionOutputLogicalId(fnName),
          distName = lambdaAtEdge.distribution,
          fnObj = template.Resources[fnLogicalName],
          fnProps = template.Resources[fnLogicalName].Properties,
          evtType = lambdaAtEdge.eventType,
          includeBody = lambdaAtEdge.includeBody || false,
          output = template.Outputs[outputName],
          dist = template.Resources[distName],
          retainFunctions = this._custom && this._custom.lambdaAtEdge && (this._custom.lambdaAtEdge.retain === true),
          distConfig, cacheBehavior, fnAssociations, versionLogicalID;

      if (!_.contains(VALID_EVENT_TYPES, evtType)) {
         throw new Error('"' + evtType + '" is not a valid event type, must be one of: ' + VALID_EVENT_TYPES.join(', '));
      }

      if (!dist) {
         throw new Error('Could not find resource with logical name "' + distName + '"');
      }

      if (dist.Type !== 'AWS::CloudFront::Distribution') {
         throw new Error('Resource with logical name "' + distName + '" is not type AWS::CloudFront::Distribution');
      }

      versionLogicalID = (output ? output.Value.Ref : null);

      if (!versionLogicalID) {
         throw new Error('Could not find output by name of "' + outputName + '" or value from it to use version ARN');
      }

      if (fnProps && fnProps.Environment && fnProps.Environment.Variables) {
         this._serverless.cli.log(
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

      if (retainFunctions) {
         fnObj.DeletionPolicy = 'Retain';
      }

      distConfig = dist.Properties.DistributionConfig;

      if (pathPattern) {
         cacheBehavior = _.findWhere(distConfig.CacheBehaviors, { PathPattern: pathPattern });

         if (!cacheBehavior) {
            throw new Error('Could not find cache behavior in "' + distName + '" with path pattern "' + pathPattern + '"');
         }
      } else {
         cacheBehavior = distConfig.DefaultCacheBehavior;
      }

      fnAssociations = cacheBehavior.LambdaFunctionAssociations;

      if (!_.isArray(fnAssociations)) {
         fnAssociations = cacheBehavior.LambdaFunctionAssociations = [];
      }

      fnAssociations.push({
         EventType: evtType,
         IncludeBody: includeBody,
         LambdaFunctionARN: { Ref: versionLogicalID },
      });

      this._serverless.cli.log(
         'Added "' + evtType + '" Lambda@Edge association for version "' +
         versionLogicalID + '" to distribution "' + distName + '"' +
         (pathPattern ? ' (path pattern "' + pathPattern + '")' : '') +
         (includeBody ? ' (IncludeBody)' : '')
      );
   },

});
