# Why the first sync was slow

Turns out the root cause was fetching commit detail for every repository on the
account, which burned most of the hourly rate limit before it finished.

The lesson: budget per-repository calls, and say in the warnings how many were
covered. Silently fetching fewer would have been a bug; fetching fewer and
saying so is the feature.
