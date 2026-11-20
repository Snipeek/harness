'use strict';
const Ajv=require('ajv');const ajv=new Ajv({strict:false,allErrors:true});const cache=new WeakMap();
function validateCall(definition,args){if(!definition)throw new Error('Tool not available');let validator=cache.get(definition);if(!validator){validator=ajv.compile(definition.function.parameters);cache.set(definition,validator);}if(!validator(args))throw new Error('Invalid tool arguments: '+ajv.errorsText(validator.errors));}
module.exports={validateCall};
