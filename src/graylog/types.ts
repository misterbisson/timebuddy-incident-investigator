/** Shapes for the subset of the Graylog legacy (2.x-5.x) HTTP API this server reads. */

/** One matched message from Graylog's universal search, as returned under `messages[]`. */
export interface GraylogMessage {
  message: {
    _id: string;
    message: string;
    timestamp: string;
    source?: string;
    /** Every other indexed field on the message (service, level, request_id, ...), alongside the fixed ones above. */
    [field: string]: unknown;
  };
}

/** Response shape of GET /api/search/universal/absolute. */
export interface GraylogSearchResponse {
  total_results: number;
  messages: GraylogMessage[];
  fields: string[];
  time: number;
}

export interface GraylogStream {
  id: string;
  title: string;
  description?: string;
  disabled?: boolean;
}

/** Response shape of GET /api/streams. */
export interface GraylogStreamsResponse {
  streams: GraylogStream[];
  total: number;
}
