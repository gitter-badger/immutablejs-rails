/**
 *  Copyright (c) 2014, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import "Sequence"
import "is"
import "invariant"
import "Cursor"
import "TrieUtils"
import "Symbol"
import "Hash"
/* global Sequence, SequenceIterator, is, invariant, Cursor,
          SHIFT, SIZE, MASK, NOT_SET, CHANGE_LENGTH, DID_ALTER, OwnerID,
          MakeRef, SetRef, arrCopy, iteratorValue, iteratorDone,
          DELETE, ITERATOR, hash */
/* exported Map, MapPrototype */


class Map extends Sequence {

  // @pragma Construction

  constructor(sequence) {
    var map = Map.empty();
    return sequence ?
      sequence.constructor === Map ?
        sequence :
        map.merge(sequence) :
      map;
  }

  static empty() {
    return EMPTY_MAP || (EMPTY_MAP = makeMap(0));
  }

  toString() {
    return this.__toString('Map {', '}');
  }

  // @pragma Access

  get(k, notSetValue) {
    return this._root ?
      this._root.get(0, hash(k), k, notSetValue) :
      notSetValue;
  }

  // @pragma Modification

  set(k, v) {
    return updateMap(this, k, v);
  }

  remove(k) {
    return updateMap(this, k, NOT_SET);
  }

  update(k, notSetValue, updater) {
    return arguments.length === 1 ?
      this.updateIn([], null, k) :
      this.updateIn([k], notSetValue, updater);
  }

  updateIn(keyPath, notSetValue, updater) {
    if (!updater) {
      [updater, notSetValue] = [notSetValue, updater];
    }
    return updateInDeepMap(this, keyPath, notSetValue, updater, 0);
  }

  clear() {
    if (this.length === 0) {
      return this;
    }
    if (this.__ownerID) {
      this.length = 0;
      this._root = null;
      this.__hash = undefined;
      this.__altered = true;
      return this;
    }
    return Map.empty();
  }

  // @pragma Composition

  merge(/*...seqs*/) {
    return mergeIntoMapWith(this, null, arguments);
  }

  mergeWith(merger, ...seqs) {
    return mergeIntoMapWith(this, merger, seqs);
  }

  mergeDeep(/*...seqs*/) {
    return mergeIntoMapWith(this, deepMerger(null), arguments);
  }

  mergeDeepWith(merger, ...seqs) {
    return mergeIntoMapWith(this, deepMerger(merger), seqs);
  }

  cursor(keyPath, onChange) {
    if (!onChange && typeof keyPath === 'function') {
      onChange = keyPath;
      keyPath = [];
    } else if (arguments.length === 0) {
      keyPath = [];
    } else if (!Array.isArray(keyPath)) {
      keyPath = [keyPath];
    }
    return new Cursor(this, keyPath, onChange);
  }

  // @pragma Mutability

  withMutations(fn) {
    var mutable = this.asMutable();
    fn(mutable);
    return mutable.wasAltered() ? mutable.__ensureOwner(this.__ownerID) : this;
  }

  asMutable() {
    return this.__ownerID ? this : this.__ensureOwner(new OwnerID());
  }

  asImmutable() {
    return this.__ensureOwner();
  }

  wasAltered() {
    return this.__altered;
  }

  keys() {
    return new MapIterator(this, 0);
  }

  values() {
    return new MapIterator(this, 1);
  }

  entries() {
    return new MapIterator(this, 2);
  }

  __iterator(reverse) {
    return new MapIterator(this, 2, reverse);
  }

  __iterate(fn, reverse) {
    var map = this;
    if (!map._root) {
      return 0;
    }
    var iterations = 0;
    this._root.iterate(entry => {
      if (fn(entry[1], entry[0], map) === false) {
        return false;
      }
      iterations++;
    }, reverse);
    return iterations;
  }

  __deepEquals(other) {
    // Using NOT_SET here ensures that a missing key is not interpretted as an
    // existing key set to be null/undefined.
    var self = this;
    return other.every((v, k) => is(self.get(k, NOT_SET), v));
  }

  __ensureOwner(ownerID) {
    if (ownerID === this.__ownerID) {
      return this;
    }
    if (!ownerID) {
      this.__ownerID = ownerID;
      this.__altered = false;
      return this;
    }
    return makeMap(this.length, this._root, ownerID, this.__hash);
  }
}

var MapPrototype = Map.prototype;
MapPrototype[DELETE] = MapPrototype.remove;
MapPrototype[ITERATOR] = function() { return this.entries() };

Map.from = Map;


class BitmapIndexedNode {

  constructor(ownerID, bitmap, nodes) {
    this.ownerID = ownerID;
    this.bitmap = bitmap;
    this.nodes = nodes;
  }

  get(shift, hash, key, notSetValue) {
    var bit = (1 << ((shift === 0 ? hash : hash >>> shift) & MASK));
    var bitmap = this.bitmap;
    return (bitmap & bit) === 0 ? notSetValue :
      this.nodes[popCount(bitmap & (bit - 1))].get(shift + SHIFT, hash, key, notSetValue);
  }

  update(ownerID, shift, hash, key, value, didChangeLength, didAlter) {
    var hashFrag = (shift === 0 ? hash : hash >>> shift) & MASK;
    var bit = 1 << hashFrag;
    var bitmap = this.bitmap;
    var exists = (bitmap & bit) !== 0;

    if (!exists && value === NOT_SET) {
      return this;
    }

    var idx = popCount(bitmap & (bit - 1));
    var nodes = this.nodes;
    var node = exists ? nodes[idx] : null;
    var newNode = updateNode(node, ownerID, shift + SHIFT, hash, key, value, didChangeLength, didAlter);

    if (newNode === node) {
      return this;
    }

    if (!exists && newNode && nodes.length >= MAX_BITMAP_SIZE) {
      return expandNodes(ownerID, nodes, bitmap, hashFrag, newNode);
    }

    if (exists && !newNode && nodes.length === 2 && isLeafNode(nodes[idx ^ 1])) {
      return nodes[idx ^ 1];
    }

    if (exists && newNode && nodes.length === 1 && isLeafNode(newNode)) {
      return newNode;
    }

    var isEditable = ownerID && ownerID === this.ownerID;
    var newBitmap = exists ? newNode ? bitmap : bitmap ^ bit : bitmap | bit;
    var newNodes = exists ? newNode ?
      setIn(nodes, idx, newNode, isEditable) :
      spliceOut(nodes, idx, isEditable) :
      spliceIn(nodes, idx, newNode, isEditable);

    if (isEditable) {
      this.bitmap = newBitmap;
      this.nodes = newNodes;
      return this;
    }

    return new BitmapIndexedNode(ownerID, newBitmap, newNodes);
  }

  iterate(fn, reverse) {
    var nodes = this.nodes;
    for (var ii = 0, maxIndex = nodes.length - 1; ii <= maxIndex; ii++) {
      if (nodes[reverse ? maxIndex - ii : ii].iterate(fn, reverse) === false) {
        return false;
      }
    }
  }
}

class ArrayNode {

  constructor(ownerID, count, nodes) {
    this.ownerID = ownerID;
    this.count = count;
    this.nodes = nodes;
  }

  get(shift, hash, key, notSetValue) {
    var idx = (shift === 0 ? hash : hash >>> shift) & MASK;
    var node = this.nodes[idx];
    return node ? node.get(shift + SHIFT, hash, key, notSetValue) : notSetValue;
  }

  update(ownerID, shift, hash, key, value, didChangeLength, didAlter) {
    var idx = (shift === 0 ? hash : hash >>> shift) & MASK;
    var removed = value === NOT_SET;
    var nodes = this.nodes;
    var node = nodes[idx];

    if (removed && !node) {
      return this;
    }

    var newNode = updateNode(node, ownerID, shift + SHIFT, hash, key, value, didChangeLength, didAlter);
    if (newNode === node) {
      return this;
    }

    var newCount = this.count;
    if (!node) {
      newCount++;
    } else if (!newNode) {
      newCount--;
      if (newCount < MIN_ARRAY_SIZE) {
        return packNodes(ownerID, nodes, newCount, idx);
      }
    }

    var isEditable = ownerID && ownerID === this.ownerID;
    var newNodes = setIn(nodes, idx, newNode, isEditable);

    if (isEditable) {
      this.count = newCount;
      this.nodes = newNodes;
      return this;
    }

    return new ArrayNode(ownerID, newCount, newNodes);
  }

  iterate(fn, reverse) {
    var nodes = this.nodes;
    for (var ii = 0, maxIndex = nodes.length - 1; ii <= maxIndex; ii++) {
      var node = nodes[reverse ? maxIndex - ii : ii];
      if (node && node.iterate(fn, reverse) === false) {
        return false;
      }
    }
  }
}

class HashCollisionNode {

  constructor(ownerID, hash, entries) {
    this.ownerID = ownerID;
    this.hash = hash;
    this.entries = entries;
  }

  get(shift, hash, key, notSetValue) {
    var entries = this.entries;
    for (var ii = 0, len = entries.length; ii < len; ii++) {
      if (is(key, entries[ii][0])) {
        return entries[ii][1];
      }
    }
    return notSetValue;
  }

  update(ownerID, shift, hash, key, value, didChangeLength, didAlter) {
    var removed = value === NOT_SET;

    if (hash !== this.hash) {
      if (removed) {
        return this;
      }
      SetRef(didAlter);
      SetRef(didChangeLength);
      return mergeIntoNode(this, ownerID, shift, hash, [key, value]);
    }

    var entries = this.entries;
    var idx = 0;
    for (var len = entries.length; idx < len; idx++) {
      if (is(key, entries[idx][0])) {
        break;
      }
    }
    var exists = idx < len;

    if (removed && !exists) {
      return this;
    }

    SetRef(didAlter);
    (removed || !exists) && SetRef(didChangeLength);

    if (removed && len === 2) {
      return new ValueNode(ownerID, this.hash, entries[idx ^ 1]);
    }

    var isEditable = ownerID && ownerID === this.ownerID;
    var newEntries = isEditable ? entries : arrCopy(entries);

    if (exists) {
      if (removed) {
        idx === len - 1 ? newEntries.pop() : (newEntries[idx] = newEntries.pop());
      } else {
        newEntries[idx] = [key, value];
      }
    } else {
      newEntries.push([key, value]);
    }

    if (isEditable) {
      this.entries = newEntries;
      return this;
    }

    return new HashCollisionNode(ownerID, this.hash, newEntries);
  }

  iterate(fn, reverse) {
    var entries = this.entries;
    for (var ii = 0, maxIndex = entries.length - 1; ii <= maxIndex; ii++) {
      if (fn(entries[reverse ? maxIndex - ii : ii]) === false) {
        return false;
      }
    }
  }
}

class ValueNode {

  constructor(ownerID, hash, entry) {
    this.ownerID = ownerID;
    this.hash = hash;
    this.entry = entry;
  }

  get(shift, hash, key, notSetValue) {
    return is(key, this.entry[0]) ? this.entry[1] : notSetValue;
  }

  update(ownerID, shift, hash, key, value, didChangeLength, didAlter) {
    var removed = value === NOT_SET;
    var keyMatch = is(key, this.entry[0]);
    if (keyMatch ? value === this.entry[1] : removed) {
      return this;
    }

    SetRef(didAlter);

    if (removed) {
      SetRef(didChangeLength);
      return null;
    }

    if (keyMatch) {
      if (ownerID && ownerID === this.ownerID) {
        this.entry[1] = value;
        return this;
      }
      return new ValueNode(ownerID, hash, [key, value]);
    }

    SetRef(didChangeLength);
    return mergeIntoNode(this, ownerID, shift, hash, [key, value]);
  }

  iterate(fn) {
    return fn(this.entry);
  }
}

class MapIterator extends SequenceIterator {

  constructor(map, type, reverse) {
    this._type = type;
    this._reverse = reverse;
    this._stack = map._root && mapIteratorFrame(map._root);
  }

  next() {
    var type = this._type;
    var stack = this._stack;
    while (stack) {
      var node = stack.node;
      var index = stack.index++;
      var maxIndex;
      if (node.entry) {
        if (index === 0) {
          return mapIteratorValue(type, node.entry);
        }
      } else if (node.entries) {
        maxIndex = node.entries.length - 1;
        if (index <= maxIndex) {
          return mapIteratorValue(type, node.entries[this._reverse ? maxIndex - index : index]);
        }
      } else {
        maxIndex = node.nodes.length - 1;
        if (index <= maxIndex) {
          var subNode = node.nodes[this._reverse ? maxIndex - index : index];
          if (subNode) {
            if (subNode.entry) {
              return mapIteratorValue(type, subNode.entry);
            }
            stack = this._stack = mapIteratorFrame(subNode, stack);
          }
          continue;
        }
      }
      stack = this._stack = this._stack.__prev;
    }
    return iteratorDone();
  }
}

function mapIteratorValue(type, entry) {
  return iteratorValue(type === 0 || type === 1 ? entry[type] : [entry[0], entry[1]]);
}

function mapIteratorFrame(node, prev) {
  return {
    node: node,
    index: 0,
    __prev: prev
  };
}

function makeMap(length, root, ownerID, hash) {
  var map = Object.create(MapPrototype);
  map.length = length;
  map._root = root;
  map.__ownerID = ownerID;
  map.__hash = hash;
  map.__altered = false;
  return map;
}

function updateMap(map, k, v) {
  var didChangeLength = MakeRef(CHANGE_LENGTH);
  var didAlter = MakeRef(DID_ALTER);
  var newRoot = updateNode(map._root, map.__ownerID, 0, hash(k), k, v, didChangeLength, didAlter);
  if (!didAlter.value) {
    return map;
  }
  var newLength = map.length + (didChangeLength.value ? v === NOT_SET ? -1 : 1 : 0);
  if (map.__ownerID) {
    map.length = newLength;
    map._root = newRoot;
    map.__hash = undefined;
    map.__altered = true;
    return map;
  }
  return newRoot ? makeMap(newLength, newRoot) : Map.empty();
}

function updateNode(node, ownerID, shift, hash, key, value, didChangeLength, didAlter) {
  if (!node) {
    if (value === NOT_SET) {
      return node;
    }
    SetRef(didAlter);
    SetRef(didChangeLength);
    return new ValueNode(ownerID, hash, [key, value]);
  }
  return node.update(ownerID, shift, hash, key, value, didChangeLength, didAlter);
}

function isLeafNode(node) {
  return node.constructor === ValueNode || node.constructor === HashCollisionNode;
}

function mergeIntoNode(node, ownerID, shift, hash, entry) {
  if (node.hash === hash) {
    return new HashCollisionNode(ownerID, hash, [node.entry, entry]);
  }

  var idx1 = (shift === 0 ? node.hash : node.hash >>> shift) & MASK;
  var idx2 = (shift === 0 ? hash : hash >>> shift) & MASK;

  var newNode;
  var nodes = idx1 === idx2 ?
    [mergeIntoNode(node, ownerID, shift + SHIFT, hash, entry)] :
    ((newNode = new ValueNode(ownerID, hash, entry)), idx1 < idx2 ? [node, newNode] : [newNode, node]);

  return new BitmapIndexedNode(ownerID, (1 << idx1) | (1 << idx2), nodes);
}

function packNodes(ownerID, nodes, count, excluding) {
  var bitmap = 0;
  var packedII = 0;
  var packedNodes = new Array(count);
  for (var ii = 0, bit = 1, len = nodes.length; ii < len; ii++, bit <<= 1) {
    var node = nodes[ii];
    if (node != null && ii !== excluding) {
      bitmap |= bit;
      packedNodes[packedII++] = node;
    }
  }
  return new BitmapIndexedNode(ownerID, bitmap, packedNodes);
}

function expandNodes(ownerID, nodes, bitmap, including, node) {
  var count = 0;
  var expandedNodes = new Array(SIZE);
  for (var ii = 0; bitmap !== 0; ii++, bitmap >>>= 1) {
    expandedNodes[ii] = bitmap & 1 ? nodes[count++] : null;
  }
  expandedNodes[including] = node;
  return new ArrayNode(ownerID, count + 1, expandedNodes);
}

function mergeIntoMapWith(map, merger, iterables) {
  var seqs = [];
  for (var ii = 0; ii < iterables.length; ii++) {
    var seq = iterables[ii];
    seq && seqs.push(
      Array.isArray(seq) ? Sequence(seq).fromEntrySeq() : Sequence(seq)
    );
  }
  return mergeIntoCollectionWith(map, merger, seqs);
}

function deepMerger(merger) {
  return (existing, value) =>
    existing && existing.mergeDeepWith ?
      existing.mergeDeepWith(merger, value) :
      merger ? merger(existing, value) : value;
}

function mergeIntoCollectionWith(collection, merger, seqs) {
  if (seqs.length === 0) {
    return collection;
  }
  return collection.withMutations(collection => {
    var mergeIntoMap = merger ?
      (value, key) => {
        var existing = collection.get(key, NOT_SET);
        collection.set(
          key, existing === NOT_SET ? value : merger(existing, value)
        );
      } :
      (value, key) => {
        collection.set(key, value);
      }
    for (var ii = 0; ii < seqs.length; ii++) {
      seqs[ii].forEach(mergeIntoMap);
    }
  });
}

function updateInDeepMap(collection, keyPath, notSetValue, updater, pathOffset) {
  var pathLen = keyPath.length;
  if (pathOffset === pathLen) {
    return updater(collection);
  }
  invariant(collection.set, 'updateIn with invalid keyPath');
  var notSet = pathOffset === pathLen - 1 ? notSetValue : Map.empty();
  var key = keyPath[pathOffset];
  var existing = collection.get(key, notSet);
  var value = updateInDeepMap(existing, keyPath, notSetValue, updater, pathOffset + 1);
  return value === existing ? collection : collection.set(key, value);
}

function popCount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  x = x + (x >> 8);
  x = x + (x >> 16);
  return x & 0x7f;
}

function setIn(array, idx, val, canEdit) {
  var newArray = canEdit ? array : arrCopy(array);
  newArray[idx] = val;
  return newArray;
}

function spliceIn(array, idx, val, canEdit) {
  var newLen = array.length + 1;
  if (canEdit && idx + 1 === newLen) {
    array[idx] = val;
    return array;
  }
  var newArray = new Array(newLen);
  var after = 0;
  for (var ii = 0; ii < newLen; ii++) {
    if (ii === idx) {
      newArray[ii] = val;
      after = -1;
    } else {
      newArray[ii] = array[ii + after];
    }
  }
  return newArray;
}

function spliceOut(array, idx, canEdit) {
  var newLen = array.length - 1;
  if (canEdit && idx === newLen) {
    array.pop();
    return array;
  }
  var newArray = new Array(newLen);
  var after = 0;
  for (var ii = 0; ii < newLen; ii++) {
    if (ii === idx) {
      after = 1;
    }
    newArray[ii] = array[ii + after];
  }
  return newArray;
}

var MAX_BITMAP_SIZE = SIZE / 2;
var MIN_ARRAY_SIZE = SIZE / 4;

var EMPTY_MAP;
