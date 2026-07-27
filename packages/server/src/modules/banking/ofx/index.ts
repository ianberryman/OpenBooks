/**
 * The OFX/QFX parser (OB-077). One `StatementParser<void>` for both dialects and both
 * formats — see `parser.ts` for why QFX is not a third thing.
 */
export { ofxStatementParser, parseOfx } from './parser';
