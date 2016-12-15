'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = pythonEngine;

var _util = require('./util');

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

/**
 * cq Python Engine
 *
 * Parse files with Python
 *
 */
var babylon = require("babylon");


// const defaultBabylonConfig = {
//   sourceType: "module",
//   plugins: [
//     // ...
//   ]
// };

var ignoredProperties = new Set(['constructor', 'parent']);

function getNodeName(node) {
  if (node.type) {
    return node.type;
  }
}

function isNode(node) {
  return node && node.type ? true : false;
}

function traverse(node, nodeCbs) {
  var nodeName = getNodeName(node);

  if (nodeCbs.hasOwnProperty(nodeName)) {
    nodeCbs[nodeName](node);
  };

  for (var prop in node) {
    if (ignoredProperties.has(prop) || prop.charAt(0) === '_') {
      continue;
    }

    var propValue = node[prop];

    if (Array.isArray(propValue)) {
      propValue.filter(function (v) {
        return isNode(v);
      }).map(function (v) {
        v.parent = node;return v;
      }).map(function (v) {
        return traverse(v, nodeCbs);
      });
    } else if (isNode(propValue)) {
      propValue.parent = node;
      traverse(propValue, nodeCbs);
    }
  }
}

function nodeToRange(node) {
  if (node.start && node.end) {
    return { start: node.start, end: node.end };
  }
  if (node.body && node.body.start && node.body.end) {
    return { start: node.body.start, end: node.body.end };
  }

  switch (node.type) {
    case 'ObjectProperty':
      return {
        start: nodeToRange(node.key).start,
        end: nodeToRange(node.value).end
      };
    default:
      console.log("unknown", node);
      throw new Error('nodeToRange of unknown type: ' + node.type);
      break;
  }
}

function pythonEngine() {
  var engineOpts = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

  return {
    parse: function parse(code) {
      var opts = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

      // let AST =
      // shell out to: 
      //     /python-to-ast.py —input somefile.py —json
      //     then parse string of python code
      //      into node AST
      // 
      // let ast = babylon.parse(code, Object.assign({}, defaultBabylonConfig, opts));
      // return ast;
      return (0, _util.spawnParseCmd)(code, opts).then(function (_ref) {
        var code = _ref.code,
            output = _ref.output;
        return { code: code, output: JSON.parse(output) };
      });
    },
    getInitialRoot: function getInitialRoot(ast) {
      return ast.Module;
    },

    nodeToRange: nodeToRange,
    commentRange: function commentRange(node, code, getLeading, getTrailing) {
      var start = node.start;
      var end = node.end;
      if (getLeading && node.leadingComments) {
        var commentRange = (0, _util.rangeExtents)(node.leadingComments.map(function (n) {
          return nodeToRange(n);
        }));
        start = Math.min(start, commentRange.start);
      }
      if (getTrailing && node.trailingComments) {
        var _commentRange = (0, _util.rangeExtents)(node.trailingComments.map(function (n) {
          return nodeToRange(n);
        }));
        end = Math.max(end, _commentRange.end);
      }
      return { nodes: [node], start: start, end: end };
    },
    findNodesWithIdentifier: function findNodesWithIdentifier(ast, root, query) {
      var paths = [];
      var nodeCb = function nodeCb(node) {
        if (node.name === query.matcher) {
          paths = [].concat(_toConsumableArray(paths), [node.parent]);
        }
      };
      traverse(root, {
        Identifier: nodeCb,
        JSXIdentifier: nodeCb
      });
      return paths;
    },
    findNodesWithString: function findNodesWithString(ast, root, query) {
      var paths = [];
      traverse(root, {
        StringLiteral: function StringLiteral(node) {
          if (node.value === query.matcher) {
            paths = [].concat(_toConsumableArray(paths), [node.parent]);
          }
        }
      });
      return paths;
    }
  };
}
module.exports = exports['default'];