The `youtube_study` tool builds static study pages for YouTube videos from
a local subtitle file, pairing the video's source language with one study
language (the learner's language; `study_language` on inspect, default
`ko`). The session model authors only `pronunciation` and `translation` in
the study language; original subtitle text and timecodes come from the
capture and cannot be changed through any operation. Flow: `inspect` a
subtitle file to capture numbered originals, `draft` study fields for line
index windows, `build` once coverage is complete, then `verify`. Load the
`youtube-study.lesson_authoring` skill before translating a video, and
always finish with a green `verify`. The tool never fetches subtitles from
the network and never publishes a generated page.
