/**
 * cq Query Resolver
 *
 * This file takes input code and a parsed query and extracts portions of the
 * code based on that query
 *
 */
import traverse from 'babel-traverse';
import parser from './query-parser';

import babylonEngine from './engines/babylon';
import typescriptEngine from './engines/typescript';

export const NodeTypes = {
  IDENTIFIER: 'IDENTIFIER',
  RANGE: 'RANGE',
  LINE_NUMBER: 'LINE_NUMBER',
  STRING: 'STRING',
  CALL_EXPRESSION: 'CALL_EXPRESSION'
};

function movePositionByLines(code, numLines, position, opts={}) {
  if(numLines < 0) {
    let numPreviousLines = numLines * -1;
    position--;
    while(position > 0 && numPreviousLines > 0) {
      position--;
      if(code[position] === '\n') {
        numPreviousLines--;
      }
    }
    if(opts.trimNewline) position++; // don't include prior newline
  } else if(numLines > 0) {
    let numFollowingLines = numLines;
    position++;
    while(position < code.length && numFollowingLines > 0) {
      if(code[position] === '\n') {
        numFollowingLines--;
      }
      position++;
    }
    if(opts.trimNewline) position--; // don't include the last newline
  }

  return position;
}

function adjustRangeWithContext(code, linesBefore, linesAfter, {start, end}) {
  if(linesBefore && linesBefore !== 0) {
    let trimNewline = linesBefore > 0 ? true : false;
    start = movePositionByLines(code, -1 * linesBefore, start, {trimNewline});
  }

  if(linesAfter && linesAfter !== 0) {
    let trimNewline = linesAfter > 0 ? true : false;
    end = movePositionByLines(code, linesAfter, end, {trimNewline});
  }

  return {start, end};
}

const whitespace = new Set([' ', '\n', '\t', '\r']);

function adjustRangeForComments(ast, code, leading, trailing, engine, {start, end, nodes}) {
  // this is going to be part of the engine
  
  nodes.map((node) => {
    let commentRange = engine.commentRange(node, code, leading, trailing);
    start = commentRange.start ? Math.min(commentRange.start, start) : start;
    end = commentRange.end ? Math.max(commentRange.end, end) : end;
  });

  return {start, end, nodes};
}

function modifyAnswerWithCall(ast, code, callee, args, engine, {start, end, nodes}) {
  switch(callee) {
  case 'upto':
    start--;
    // trim all of the whitespace before. TODO could be to make this optional
    while(start > 0 && whitespace.has(code[start])) {
      start--;
    }
    start++;
    return {start: start, end:start};
    break;
  case 'context':
    let [linesBefore, linesAfter] = args;
    return adjustRangeWithContext(code, linesBefore.value, linesAfter.value, {start, end})
    break;
  case 'comments':
    let leading = true, trailing = false;
    return adjustRangeForComments(ast, code, leading, trailing, engine, {start, end, nodes})
    break;
  default:
    throw new Error(`Unknown function call: ${callee}`);
  }
}

function resolveIndividualQuery(ast, root, code, query, engine, opts) {
  switch(query.type) {
  case NodeTypes.CALL_EXPRESSION: {
    let callee = query.callee;
    // for now, the first argument is always the inner selection
    let [childQuery, ...args] = query.arguments;
    let answer = resolveIndividualQuery(ast, root, code, childQuery, engine, opts);

    // whatever the child answer is, now we modify it given our callee
    // TODO - modifying the asnwer needs to be given not only the answer start and end range, but the child node which returned that start and end 
    answer = modifyAnswerWithCall(ast, code, callee, args, engine, answer);

    // hmm, maybe do this later in the pipeline?
    answer.code = code.substring(answer.start, answer.end);

    // get the rest of the parameters
    return answer;
  }
  case NodeTypes.IDENTIFIER:
  case NodeTypes.STRING: {
    let nextRoot;
    let matchingNodes;

    switch(query.type) {
    case NodeTypes.IDENTIFIER:
      matchingNodes = engine.findNodesWithIdentifier(ast, root, query);
      break;
    case NodeTypes.STRING:
      matchingNodes = engine.findNodesWithString(ast, root, query);
      break;
    }

    if(opts.after) {
      for(let i=0; i<matchingNodes.length; i++) {
        let node = matchingNodes[i];
        let nodeRange = engine.nodeToRange(node);
        if(nodeRange.start >= opts.after) {
          nextRoot = node;
          break;
        }
      }
    } else {
      nextRoot = matchingNodes[0];
    }

    if(!nextRoot) {
      throw new Error(`Cannot find node for query: ${query.matcher}`);
    }

    let range = engine.nodeToRange(nextRoot);

    // we want to keep starting indentation, so search back to the previous
    // newline
    let start = range.start;
    while(start > 0 && code[start] !== '\n') {
      start--;
    }
    start++; // don't include the newline

    // we also want to read to the end of the line for the node we found
    let end = range.end;
    while(end < code.length && code[end] !== '\n') {
      end++;
    }

    let codeSlice = code.substring(start, end);

    if(query.children) {
      return resolveListOfQueries(ast, nextRoot, code, query.children, engine, opts);
    } else {
      return { code: codeSlice, nodes: [ nextRoot ], start, end };
    }
  }
  case NodeTypes.RANGE: {
    let rangeStart = resolveIndividualQuery(ast, root, code, query.start, engine, opts);
    let start = rangeStart.start;
    let rangeEnd = resolveIndividualQuery(ast, root, code, query.end, engine, 
                                          Object.assign({}, opts, {after: rangeStart.end}));
    let end = rangeEnd.end;
    let codeSlice = code.substring(start, end);
    let nodes = [...(rangeStart.nodes || []), ...(rangeEnd.nodes || [])]
    return { code: codeSlice, nodes, start, end };
  }
  case NodeTypes.LINE_NUMBER: {

    // Parse special line numbers like EOF
    if(typeof query.value === 'string') {
      switch(query.value) {
      case 'EOF': 
        return { code: '', start: code.length, end: code.length };
        break;
      default:
        throw new Error(`Unknown LINE_NUMBER: ${query.value}`);
      }
    } else {

      if(query.value === 0) {
        throw new Error(`Line numbers start at 1, not 0`);
      }

      // find the acutal line number
      let lines = code.split('\n');
      let line = lines[query.value - 1]; // one-indexed arguments to LINE_NUMBER 

      // to get the starting index of this line...
      // we take the sum of all prior lines:
      let charIdx = lines.slice(0, query.value - 1).reduce(
        // + 1 b/c of the (now missing) newline
        (sum, line) => (sum + line.length + 1), 0);

      let start = charIdx;
      let end = charIdx + line.length;
      let codeSlice = code.substring(start, end);
      let nodes = []; // TODO - find the node that applies to this line number
      return { code: codeSlice, nodes, start, end };
    }

  }
  default:
    break;
  }

}

// given character index idx in code, returns the 1-indexed line number 
function lineNumberOfCharacterIndex(code, idx) {
  const everythingUpUntilTheIndex = code.substring(0, idx);
  // computer science!
  return everythingUpUntilTheIndex.split('\n').length;
}

function resolveListOfQueries(ast, root, code, query, engine, opts) {
  return query.reduce((acc, q) => {
    let resolved = resolveIndividualQuery(ast, root, code, q, engine, opts);
    // thought: maybe do something clever here like put in a comment ellipsis if
    // the queries aren't contiguous
    acc.code = acc.code + resolved.code;
    acc.nodes = [...acc.nodes, resolved.node];
    acc.start = Math.min(acc.start, resolved.start);
    acc.end = Math.max(acc.end, resolved.end);
    acc.start_line = Math.min(acc.start_line, lineNumberOfCharacterIndex(code, resolved.start));
    acc.end_line = Math.max(acc.end_line, lineNumberOfCharacterIndex(code, resolved.end));
    return acc;
  }, {
    code: '',
    nodes: [],
    start: Number.MAX_VALUE,
    end: Number.MIN_VALUE,
    start_line: Number.MAX_VALUE,
    end_line: Number.MIN_VALUE
  })
}

export default function cq(code, query, opts={}) {
  let engine = opts.engine || babylonEngine();

  if(typeof query === 'string') {
    query = [ parser.parse(query) ]; // parser returns single object for now, but eventually an array
  }

  if(typeof engine === 'string') {
    switch(engine) {
    case 'typescript':
      engine = typescriptEngine();
      break;
    case 'babylon':
      engine = babylonEngine();
      break;
    default:
      throw new Error('unknown engine: ' + engine);
    }
  }

  let ast = engine.parse(code, Object.assign({}, opts.parserOpts));
  let root = engine.getInitialRoot(ast);

  return resolveListOfQueries(ast, root, code, query, engine, opts);
}
