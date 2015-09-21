
var MongoID = require('mongo-id');
var Meteor = require('meteor-client');
var IdMap = require('id-map');

var MongoIDMap = function () {
  var self = this;
  IdMap.call(self, MongoID.idStringify, MongoID.idParse);
};

Meteor._inherits(MongoIDMap, IdMap);

module.exports = MongoIDMap;
