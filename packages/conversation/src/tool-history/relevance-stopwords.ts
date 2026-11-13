// General English function words (Snowball-style), separate from ranking intent.
// Includes tokenized contraction fragments because relevanceQuery splits apostrophes.
export const englishStopWords = new Set(`a ain about above after again against all am an and any are aren as at
be because been before being below between both but by can could couldn d did didn do does doesn doing don down during
each few for from further had hadn has hasn have haven having he her here hers herself him himself his how
i if in into is isn it its itself just ll m ma me might mightn more most must mustn my myself
needn no nor not now o of off on once only or other our ours ourselves out over own re s same shan she should shouldn so some such
t than that the their theirs them themselves then there these they this those through to too under until up ve very
was wasn we were weren what when where which while who whom why will with won would wouldn y you your yours yourself yourselves`.split(/\s+/u));
