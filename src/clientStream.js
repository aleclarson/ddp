
var Tracker = require('tracker');
var Meteor = require('meteor-client');
var Retry = require('retry');
var _ = require('underscore');

var DDP = require('./ddp');

// @param url {String} URL to Meteor app
//   "http://subdomain.meteor.com/" or "/" or
//   "ddp+sockjs://foo-**.meteor.com/sockjs"
var ClientStream = function (url, options) {
  var self = this;
  self.options = _.extend({
    retry: true
  }, options);
  self._initCommon(self.options);

  //// Constants


  // how long between hearing heartbeat from the server until we declare
  // the connection dead. heartbeats come every 45s (stream_server.js)
  //
  // NOTE: this is a older timeout mechanism. We now send heartbeats at
  // the DDP level (https://github.com/meteor/meteor/pull/1865), and
  // expect those timeouts to kill a non-responsive connection before
  // this timeout fires. This is kept around for compatibility (when
  // talking to a server that doesn't support DDP heartbeats) and can be
  // removed later.
  self.HEARTBEAT_TIMEOUT = 100*1000;

  self.rawUrl = url;
  self.socket = null;

  self.heartbeatTimer = null;

  // Listen to global 'online' event if we are running in a browser.
  // (IE8 does not support addEventListener)
  if (typeof window !== 'undefined' && window.addEventListener)
    window.addEventListener("online", _.bind(self._online, self),
                            false /* useCapture. make FF3.6 happy. */);

  //// Kickoff!
  self._launchConnection();
};

_.extend(ClientStream.prototype, {

  // data is a utf8 string. Data sent while not connected is dropped on
  // the floor, and it is up the user of this API to retransmit lost
  // messages on 'reset'
  send: function (data) {
    var self = this;
    if (self.currentStatus.connected) {
      self.socket.send(data);
    }
  },

  // Changes where this connection points
  _changeUrl: function (url) {
    var self = this;
    self.rawUrl = url;
  },

  _connected: function () {
    var self = this;

    if (self.connectionTimer) {
      clearTimeout(self.connectionTimer);
      self.connectionTimer = null;
    }

    if (self.currentStatus.connected) {
      // already connected. do nothing. this probably shouldn't happen.
      return;
    }

    // update status
    self.currentStatus.status = "connected";
    self.currentStatus.connected = true;
    self.currentStatus.retryCount = 0;
    self.statusChanged();

    // fire resets. This must come after status change so that clients
    // can call send from within a reset callback.
    _.each(self.eventCallbacks.reset, function (callback) { callback(); });

  },

  _cleanup: function (maybeError) {
    var self = this;

    self._clearConnectionAndHeartbeatTimers();
    if (self.socket) {
      self.socket.onmessage = self.socket.onclose
        = self.socket.onerror = self.socket.onheartbeat = function () {};
      self.socket.close();
      self.socket = null;
    }

    _.each(self.eventCallbacks.disconnect, function (callback) {
      callback(maybeError);
    });
  },

  _clearConnectionAndHeartbeatTimers: function () {
    var self = this;
    if (self.connectionTimer) {
      clearTimeout(self.connectionTimer);
      self.connectionTimer = null;
    }
    if (self.heartbeatTimer) {
      clearTimeout(self.heartbeatTimer);
      self.heartbeatTimer = null;
    }
  },

  _heartbeat_timeout: function () {
    var self = this;
    Meteor._debug("Connection timeout. No sockjs heartbeat received.");
    self._lostConnection(new DDP.ConnectionError("Heartbeat timed out"));
  },

  _heartbeat_received: function () {
    var self = this;
    // If we've already permanently shut down this stream, the timeout is
    // already cleared, and we don't need to set it again.
    if (self._forcedToDisconnect)
      return;
    if (self.heartbeatTimer)
      clearTimeout(self.heartbeatTimer);
    self.heartbeatTimer = setTimeout(
      _.bind(self._heartbeat_timeout, self),
      self.HEARTBEAT_TIMEOUT);
  },

  _launchConnection: function () {
    var self = this;
    self._cleanup(); // cleanup the old socket, if there was one.

    self.socket = new WebSocket(self.rawUrl);

    self.socket.onopen = function (data) {
      self._connected();
    };

    self.socket.onmessage = function (data) {
      self._heartbeat_received();

      if (self.currentStatus.connected)
        _.each(self.eventCallbacks.message, function (callback) {
          callback(data.data);
        });
    };

    self.socket.onclose = function () {
      self._lostConnection();
    };

    self.socket.onerror = function () {
      // XXX is this ever called?
      Meteor._debug("stream error", _.toArray(arguments), (new Date()).toDateString());
    };

    self.socket.onheartbeat =  function () {
      self._heartbeat_received();
    };

    if (self.connectionTimer)
      clearTimeout(self.connectionTimer);

    self.connectionTimer = setTimeout(function () {
      self._lostConnection(
        new DDP.ConnectionError("DDP connection timed out"));
    }, self.CONNECT_TIMEOUT);
  }
});

// XXX from Underscore.String (http://epeli.github.com/underscore.string/)
var startsWith = function(str, starts) {
  return str.length >= starts.length &&
    str.substring(0, starts.length) === starts;
};

var endsWith = function(str, ends) {
  return str.length >= ends.length &&
    str.substring(str.length - ends.length) === ends;
};

// @param url {String} URL to Meteor app, eg:
//   "/" or "madewith.meteor.com" or "https://foo.meteor.com"
//   or "ddp+sockjs://ddp--****-foo.meteor.com/sockjs"
// @returns {String} URL to the endpoint with the specific scheme and subPath, e.g.
// for scheme "http" and subPath "sockjs"
//   "http://subdomain.meteor.com/sockjs" or "/sockjs"
//   or "https://ddp--1234-foo.meteor.com/sockjs"
var translateUrl =  function(url, newSchemeBase, subPath) {
  if (! newSchemeBase) {
    newSchemeBase = "http";
  }

  var ddpUrlMatch = url.match(/^ddp(i?)\+sockjs:\/\//);
  var httpUrlMatch = url.match(/^http(s?):\/\//);
  var newScheme;
  if (ddpUrlMatch) {
    // Remove scheme and split off the host.
    var urlAfterDDP = url.substr(ddpUrlMatch[0].length);
    newScheme = ddpUrlMatch[1] === "i" ? newSchemeBase : newSchemeBase + "s";
    var slashPos = urlAfterDDP.indexOf('/');
    var host =
          slashPos === -1 ? urlAfterDDP : urlAfterDDP.substr(0, slashPos);
    var rest = slashPos === -1 ? '' : urlAfterDDP.substr(slashPos);

    // In the host (ONLY!), change '*' characters into random digits. This
    // allows different stream connections to connect to different hostnames
    // and avoid browser per-hostname connection limits.
    host = host.replace(/\*/g, function () {
      return Math.floor(Random.fraction()*10);
    });

    return newScheme + '://' + host + rest;
  } else if (httpUrlMatch) {
    newScheme = !httpUrlMatch[1] ? newSchemeBase : newSchemeBase + "s";
    var urlAfterHttp = url.substr(httpUrlMatch[0].length);
    url = newScheme + "://" + urlAfterHttp;
  }

  // Prefix FQDNs but not relative URLs
  if (url.indexOf("://") === -1 && !startsWith(url, "/")) {
    url = newSchemeBase + "://" + url;
  }

  // XXX This is not what we should be doing: if I have a site
  // deployed at "/foo", then DDP.connect("/") should actually connect
  // to "/", not to "/foo". "/" is an absolute path. (Contrast: if
  // deployed at "/foo", it would be reasonable for DDP.connect("bar")
  // to connect to "/foo/bar").
  //
  // We should make this properly honor absolute paths rather than
  // forcing the path to be relative to the site root. Simultaneously,
  // we should set DDP_DEFAULT_CONNECTION_URL to include the site
  // root. See also client_convenience.js #RationalizingRelativeDDPURLs
  url = Meteor._relativeToSiteRootUrl(url);

  if (endsWith(url, "/"))
    return url + subPath;
  else
    return url + "/" + subPath;
};

var toSockjsUrl = function (url) {
  return translateUrl(url, "http", "sockjs");
};

_.extend(ClientStream.prototype, {

  // Register for callbacks.
  on: function (name, callback) {
    var self = this;

    if (name !== 'message' && name !== 'reset' && name !== 'disconnect')
      throw new Error("unknown event type: " + name);

    if (!self.eventCallbacks[name])
      self.eventCallbacks[name] = [];
    self.eventCallbacks[name].push(callback);
  },


  _initCommon: function (options) {
    var self = this;
    options = options || {};

    //// Constants

    // how long to wait until we declare the connection attempt
    // failed.
    self.CONNECT_TIMEOUT = options.connectTimeoutMs || 10000;

    self.eventCallbacks = {}; // name -> [callback]

    self._forcedToDisconnect = false;

    //// Reactive status
    self.currentStatus = {
      status: "connecting",
      connected: false,
      retryCount: 0
    };


    self.statusListeners = new Tracker.Dependency;
    self.statusChanged = function () {
      if (self.statusListeners)
        self.statusListeners.changed();
    };

    //// Retry logic
    self._retry = new Retry;
    self.connectionTimer = null;

  },

  // Trigger a reconnect.
  reconnect: function (options) {
    var self = this;
    options = options || {};

    if (options.url) {
      self._changeUrl(options.url);
    }

    if (self.currentStatus.connected) {
      if (options._force || options.url) {
        // force reconnect.
        self._lostConnection(new DDP.ForcedReconnectError);
      } // else, noop.
      return;
    }

    // if we're mid-connection, stop it.
    if (self.currentStatus.status === "connecting") {
      // Pretend it's a clean close.
      self._lostConnection();
    }

    self._retry.clear();
    self.currentStatus.retryCount -= 1; // don't count manual retries
    self._retryNow();
  },

  disconnect: function (options) {
    var self = this;
    options = options || {};

    // Failed is permanent. If we're failed, don't let people go back
    // online by calling 'disconnect' then 'reconnect'.
    if (self._forcedToDisconnect)
      return;

    // If _permanent is set, permanently disconnect a stream. Once a stream
    // is forced to disconnect, it can never reconnect. This is for
    // error cases such as ddp version mismatch, where trying again
    // won't fix the problem.
    if (options._permanent) {
      self._forcedToDisconnect = true;
    }

    self._cleanup();
    self._retry.clear();

    self.currentStatus = {
      status: (options._permanent ? "failed" : "offline"),
      connected: false,
      retryCount: 0
    };

    if (options._permanent && options._error)
      self.currentStatus.reason = options._error;

    self.statusChanged();
  },

  // maybeError is set unless it's a clean protocol-level close.
  _lostConnection: function (maybeError) {
    var self = this;

    self._cleanup(maybeError);
    self._retryLater(maybeError); // sets status. no need to do it here.
  },

  // fired when we detect that we've gone online. try to reconnect
  // immediately.
  _online: function () {
    // if we've requested to be offline by disconnecting, don't reconnect.
    if (this.currentStatus.status != "offline")
      this.reconnect();
  },

  _retryLater: function (maybeError) {
    var self = this;

    var timeout = 0;
    if (self.options.retry ||
        (maybeError && maybeError.errorType === "DDP.ForcedReconnectError")) {
      timeout = self._retry.retryLater(
        self.currentStatus.retryCount,
        _.bind(self._retryNow, self)
      );
      self.currentStatus.status = "waiting";
      self.currentStatus.retryTime = (new Date()).getTime() + timeout;
    } else {
      self.currentStatus.status = "failed";
      delete self.currentStatus.retryTime;
    }

    self.currentStatus.connected = false;
    self.statusChanged();
  },

  _retryNow: function () {
    var self = this;

    if (self._forcedToDisconnect)
      return;

    self.currentStatus.retryCount += 1;
    self.currentStatus.status = "connecting";
    self.currentStatus.connected = false;
    delete self.currentStatus.retryTime;
    self.statusChanged();

    self._launchConnection();
  },


  // Get current status. Reactive.
  status: function () {
    var self = this;
    if (self.statusListeners)
      self.statusListeners.depend();
    return self.currentStatus;
  }
});

module.exports = ClientStream;
