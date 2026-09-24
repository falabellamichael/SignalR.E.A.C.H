'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseProjectCommand } = require('../renderer/command-line.js');

test('project and Home commands keep quoted prompts as one argument', () => {
  assert.deepEqual(parseProjectCommand('python3 tools/reach-cli.py ask "hello world"'),
    ['python3', 'tools/reach-cli.py', 'ask', 'hello world']);
  assert.deepEqual(parseProjectCommand("python3 tools/reach-cli.py web 'what is REACH Studio?'"),
    ['python3', 'tools/reach-cli.py', 'web', 'what is REACH Studio?']);
});

test('quoted executable paths, empty values, and adjacent text retain boundaries', () => {
  assert.deepEqual(parseProjectCommand(String.raw`"C:\Program Files\REACH\tool.exe" --name="two words" ''`),
    [String.raw`C:\Program Files\REACH\tool.exe`, '--name=two words', '']);
  assert.deepEqual(parseProjectCommand(String.raw`node -e "console.log(\"hello world\")"`),
    ['node', '-e', 'console.log("hello world")']);
});

test('the command parser never expands shell syntax', () => {
  assert.deepEqual(parseProjectCommand('echo $HOME | cat && echo done'),
    ['echo', '$HOME', '|', 'cat', '&&', 'echo', 'done']);
});

test('unclosed quotes are rejected before starting a process', () => {
  assert.throws(() => parseProjectCommand('python3 ask "hello world'), /Unclosed double quote/);
  assert.throws(() => parseProjectCommand("python3 ask 'hello world"), /Unclosed single quote/);
});
