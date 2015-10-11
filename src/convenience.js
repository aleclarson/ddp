
var Meteor = require('meteor-client');
var Reload = require('reload');
var Retry = require('retry');
var _ = require('underscore');

var DDP = require('./ddp');

var retry = new Retry;

var onDDPVersionNegotiationFailure = function (description) {
  Meteor._debug(description);
  var migrationData = Reload._migrationData('livedata') || {};
  var failures = migrationData.DDPVersionNegotiationFailures || 0;
  ++failures;
  Reload._onMigrate('livedata', function () {
    return [true, {DDPVersionNegotiationFailures: failures}];
  });
  retry.retryLater(failures, function () {
    Reload._reload();
  });
};

Meteor.connect = function(url) {

  console.log('Connecting to: ' + url);

  Meteor.absoluteUrl.defaultOptions.rootUrl = url;

  Meteor.connection = DDP.connect(url, {
    onDDPVersionNegotiationFailure: onDDPVersionNegotiationFailure,
    onConnected: function () {
      console.log('Connected to: ' + url);
    }
  });

  var connectionMethods = [
    'subscribe',
    'methods',
    'call',
    'apply',
    'status',
    'reconnect',
    'disconnect',
  ];

  // Proxy the public methods of Meteor.connection so they can
  // be called directly on Meteor.
  _.each(connectionMethods, function (name) {
    Meteor[name] = _.bind(Meteor.connection[name], Meteor.connection);
  });
};
