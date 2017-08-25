'use strict';

module.exports = function(grunt) {

   var config;

   config = {
      js: {
         all: [ 'Gruntfile.js', 'src/**/*.js', '!**/node_modules/**/*' ],
      },
   };

   grunt.initConfig({

      pkg: grunt.file.readJSON('package.json'),

      eslint: {
         target: config.js.all,
      },

   });

   grunt.loadNpmTasks('grunt-eslint');

   grunt.registerTask('standards', [ 'eslint' ]);
   grunt.registerTask('default', [ 'standards' ]);

};
