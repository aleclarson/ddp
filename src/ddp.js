
var Meteor = require('meteor-client');

Meteor.DDP = {

  // @param url {String} URL to Meteor app,
  //     e.g.:
  //     "localhost:3000"
  //     "subdomain.meteor.com"
  //     "http://subdomain.meteor.com"
  //     "/"
  //     "ddp+sockjs://ddp--****-foo.meteor.com/sockjs"

  /**
   * @summary Connect to the server of a different Meteor application to subscribe to its document sets and invoke its remote methods.
   * @locus Anywhere
   * @param {String} url The URL of another Meteor application.
   */
  connect: function (url, options) {
    var ret = new Connection(url, options);
    allConnections.push(ret); // hack. see below.
    return ret;
  },

  ConnectionError: Meteor.makeErrorType("DDP.ConnectionError", function (message) {
    this.message = message;
  }),

  ForcedReconnectError: Meteor.makeErrorType("DDP.ForcedReconnectError", function () {
    // no-op
  }),

  // This is private but it's used in a few places. accounts-base uses
  // it to get the current user. Meteor.setTimeout and friends clear
  // it. We can probably find a better way to factor this.
  _CurrentInvocation: new Meteor.EnvironmentVariable,
};

module.exports = Meteor.DDP;
