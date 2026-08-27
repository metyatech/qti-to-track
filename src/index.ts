export { loadQtiPackage } from './fs/qti-loader.js';
export { toTrackPayloads } from './generator/track-generator.js';

export {
  getPublishFailureExitCode,
  hasPartialPublishProgress,
  isTrackAuthenticationError,
  TRACK_AUTH_EXIT_CODE,
} from './publish/publisher.js';

export {
  parseAssessmentItemXml,
  parseAssessmentXml,
  parseQtiPackageFromXml,
} from './parser/qti-parser.js';

export type {
  ParsedAssessment,
  ParsedAssessmentItemRef,
  ParsedBlank,
  ParsedChoice,
  ParsedQtiChoice,
  ParsedQtiItem,
  ParsedQtiPackage,
  TrackMaterialDraft,
  TrackQuestionType,
} from './types.js';

export type {
  TrackBlankPayload,
  TrackChoicePayload,
  TrackMaterialPayload,
  TrackQuestionPayload,
} from '@metyatech/track-tcm-api-client';
