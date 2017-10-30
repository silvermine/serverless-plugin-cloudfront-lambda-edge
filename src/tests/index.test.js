'use strict';
var _ = require('underscore'),
    expect = require('expect.js'),
    Plugin = require('../index.js'),
    sinon = require('sinon');

function stubServerless() {
   return {
      getProvider: function() {
         return {};
      },
      cli: {
         log: _.noop,
         consoleLog: _.noop,
         printDot: _.noop,
      },
   };
}

describe('serverless-plugin-cloudfront-lambda-edge', function() {
   var plugin,
       functions,
       template;

   beforeEach(function() {
      plugin = new Plugin(stubServerless(), {});
      plugin._provider.request = sinon.stub();
      plugin._provider.naming = {
         getLambdaLogicalId: sinon.stub().callsFake(function(fnName) {
            return 'log_id_' + fnName;
         }),
         getLambdaVersionOutputLogicalId: sinon.stub().callsFake(function(fnName) {
            return 'lambda_ver_id_' + fnName;
         }),
         getStackName: sinon.stub().returns('some-stack'),
      };

      functions = {
         someFn: {
            lambdaAtEdge: {
               distribution: 'WebDist',
               distributionID: '123ABC',
               eventType: 'viewer-request',
            },
         },
      };

      template = {
         Resources: {
            'log_id_someFn': {
               Properties: {},
            },
         },
      };


      plugin._serverless.service = {
         functions: functions,
      };
   });


   describe('_modifyLambdaFunctions()', function() {
      it('does nothing if lambdaAtEdge doesnt exist', function() {
         functions = {
            someFn: {},
         };
         plugin._modifyLambdaFunctions(functions, template);
         expect(plugin._pendingAssociations).to.eql([]);
      });

      it('requires a valid event type', function() {
         functions.someFn.lambdaAtEdge.eventType = 'wrong-event';
         expect(plugin._modifyLambdaFunctions).withArgs(functions, template).to
            .throwException(/"wrong-event" is not a valid event type, must be one of/);
      });

      it('requires a valid distribution', function() {
         functions.someFn.lambdaAtEdge.distributionID = null;
         functions.someFn.lambdaAtEdge.distribution = 'not-existing';
         expect(plugin._modifyLambdaFunctions).withArgs(functions, template).to
            .throwException(/Could not find resource with logical name "not-existing" or there is no distributionID set/);
      });

      it('requires a distribution even with distributionID', function() {
         functions.someFn.lambdaAtEdge.distribution = null;
         expect(plugin._modifyLambdaFunctions.bind(plugin)).withArgs(functions, template).to
            .throwException(/Distribution ID "123ABC" requires a distribution to be set/);
      });

      it('requires resource type to be AWS::CloudFront::Distribution', function() {
         functions.someFn.lambdaAtEdge.distributionID = null;
         functions.someFn.lambdaAtEdge.distribution = 'SomeRes';

         template.Resources.SomeRes = { Type: 'wrongtype' };

         expect(plugin._modifyLambdaFunctions).withArgs(functions, template).to
            .throwException(/Resource with logical name "SomeRes" is not type AWS::CloudFront::Distribution/);
      });

      it('adds valid pending association', function() {
         functions.someFn.lambdaAtEdge.distributionID = null;
         template.Resources.WebDist = { Type: 'AWS::CloudFront::Distribution' };

         plugin._modifyLambdaFunctions(functions, template);

         expect(plugin._pendingAssociations[0]).to.eql({
            fnLogicalName: 'log_id_someFn',
            distLogicalName: 'WebDist',
            distributionID: null,
            fnCurrentVersionOutputName: 'lambda_ver_id_someFn',
            eventType: 'viewer-request',
         });

         sinon.assert.calledWith(plugin._provider.naming.getLambdaLogicalId, 'someFn');
         sinon.assert.calledWith(plugin._provider.naming.getLambdaVersionOutputLogicalId, 'someFn');
      });

      it('accepts a distribution Id in place of a Resource distribution', function() {
         functions.someFn.lambdaAtEdge.distribution = 'ExistingWebDist';
         plugin._modifyLambdaFunctions(functions, template);

         expect(plugin._pendingAssociations[0]).to.eql({
            fnLogicalName: 'log_id_someFn',
            distLogicalName: 'ExistingWebDist',
            distributionID: '123ABC',
            fnCurrentVersionOutputName: 'lambda_ver_id_someFn',
            eventType: 'viewer-request',
         });
      });
   });

   describe('_getDistributionPhysicalIDs()', function() {
      it('does not call describeStackResource if all pending contain distributionIDs', function() {
         plugin._pendingAssociations = [
            { distLogicalName: 'WebDist1', distributionID: 'ABC' },
            { distLogicalName: 'WebDist2', distributionID: 'DEF' },
         ];
         return plugin._getDistributionPhysicalIDs().then(function(dists) {
            expect(dists).to.eql({
               WebDist1: 'ABC',
               WebDist2: 'DEF',
            });
            sinon.assert.notCalled(plugin._provider.request);
         });
      });

      it('gets physical id from stack', function() {
         plugin._pendingAssociations = [
            { distLogicalName: 'WebDist', distributionID: null },
         ];

         plugin._provider.request.withArgs('CloudFormation', 'describeStackResources', { StackName: 'some-stack' })
            .resolves({
               StackResources: [
                  {
                     LogicalResourceId: 'WebDist',
                     PhysicalResourceId: 'ABC123',
                  },
               ],
            });

         return plugin._getDistributionPhysicalIDs().then(function(dists) {
            expect(dists).to.eql({ WebDist: 'ABC123' });
         });
      });
   });
});
