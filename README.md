
# ddp v1.2.0 [![experimental](http://badges.github.io/stability-badges/dist/experimental.svg)](http://github.com/badges/stability-badges)

This package is stripped from [meteor/ddp](https://atmospherejs.com/meteor/ddp) and made compatible with [React Native](https://github.com/facebook/react-native).

**Note:** This package is only for client-side usage.

&nbsp;

## usage

```js
var DDP = require('ddp');

var connection = DDP.connect('localhost:3000', {
  heartbeatInterval: 17500, // Interval to send pings (in milliseconds)
  heartbeatTimeout: 15000,  // Timeout to close the connection if a reply isnt received (in milliseconds)
  onConnected: function () { /* ... */ },
});

// Subscribe to a record set.
connection.subscribe('subscriptionName', args..., {
  onReady: function () { /* ... */ },
  onStop: function () { /* ... */ },
});

// Invoke a method passing any number of arguments.
connection.call('methodName', args..., function (error, result) { /* onComplete */ });
connection.apply('methodName', args, function (error, result) { /* onComplete */ });
```

This package also exposes:

- `Meteor.connection`: This should be preferred over using `DDP.connect()`

- `Meteor.DDP`

- `DDP.randomStream()`

- `DDP.stringify()`

- `DDP.parse()`

&nbsp;

## install

```sh
npm install aleclarson/ddp#1.2.0
```

&nbsp;

## contributions

Pull requests are welcome, but should be against the `devel` branch.
