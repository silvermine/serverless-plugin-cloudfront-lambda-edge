'use strict';

var _ = require('underscore'),
    expect = require('expect.js'),
    Plugin = require('../index.js'),
    sinon = require('sinon'); // eslint-disable-line no-unused-vars

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
   var plugin; // eslint-disable-line no-unused-vars

   beforeEach(function() {
      plugin = new Plugin(stubServerless(), {});
   });

   describe('TODO', function() {

      it('needs to be tested', function() {
         expect(1).to.eql(1);
      });

   });

});
