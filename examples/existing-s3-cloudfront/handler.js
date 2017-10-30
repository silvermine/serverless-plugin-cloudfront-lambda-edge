'use strict';
/* eslint-disable no-console */

module.exports = {

  // invoked by CloudFront (origin response)
   handler: function(event, context, cb) {
      var response = event.Records[0].cf.response,
          headers = response.headers;

      headers['x-serverless-example'] = [
         {
            key: 'X-Serverless-Example',
            value: 'Existing s3 bucket and clodfront',
         },
      ];

      cb(null, response);
   },

};
