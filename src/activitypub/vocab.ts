/** The ActivityStreams 2.0 context every document we publish declares. */
export const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'

/** Addressing a note here is what makes it public: it is the marker every fediverse
 *  implementation looks for before showing a post to someone who does not follow us. */
export const PUBLIC_COLLECTION = 'https://www.w3.org/ns/activitystreams#Public'
