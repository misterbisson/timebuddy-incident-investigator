/** One message as returned by Graylog's legacy Universal Search API — the actual log fields live under `message`, keyed by whatever's indexed (message/timestamp/source/_id are always present; everything else is deployment-specific). */
export interface GraylogMessageWrapper {
  index?: string;
  message: {
    _id?: string;
    message: string;
    timestamp: string;
    source?: string;
    [field: string]: unknown;
  };
}

export interface GraylogSearchResponse {
  messages: GraylogMessageWrapper[];
  total_results: number;
  fields?: string[];
  time?: number;
}

export interface GraylogStream {
  id: string;
  title: string;
  description?: string;
}

export interface GraylogStreamsResponse {
  streams: GraylogStream[];
  total: number;
}
