'use strict';

function sessionTitle(value) {
  if(typeof value !== 'string')return '';
  const line = value.trim().replace(/^[#*"'«]+|[*"'»]+$/g,'').trim();
  const words = line.split(/\s+/);
  return line && !/[\r\n]/.test(line) && line.length <= 80 && words.length <= 10 ? line : '';
}
module.exports = { sessionTitle };
