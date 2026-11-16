# Apply fixtures

Real LinkedIn pages saved by `runner snapshot` on 2026-11-12 (and 2026-11-14 for job G), scrubbed by `runner snapshot scrub`, and read by Claude for personal data before commit. The two nodes that belong to the author's own browser extensions (screen recorder and video companion) were removed from every file.

`review-backdrop-prompt.html` is a contact step with LinkedIn's "Save this application?" prompt open over it, after a press landed on the backdrop. Its kind is `step` because the form behind the prompt still reads as one; the page has two Dismiss buttons, the form's and the prompt's.

`review-follow.html` is a review page (job G, 2026-11-14) with LinkedIn's "Follow <company> to stay up to date with their page" checkbox inside the form dialog. The earlier review captures carry the same checkbox; the captures hold no checked state, which the runner reads live.

`sent-dialog-2.html` is the job page with LinkedIn's "Your application was sent" dialog open over it, right after the author's own submit on job G. It also reads as an applied job page (its "Application status" heading, no Easy Apply button), so it is listed as `job-applied`. No separate capture of the job page after that dialog was closed exists, so there is no `job-applied-2.html`.

`step-contact-city.html` (job H) is a contact step with LinkedIn's optional "Location (city)" typeahead, whose question is a `<p>` in its field wrapper rather than a `<label>`; the scrubber keeps that `<p>`. It was captured before anything was typed, so it holds no suggestion list. `step-contact-de.html` (job I) is a contact step whose labels are in German ("E-Mail-Adresse", "Handynummer"). Both were scrubbed on 2026-11-16 and leak-checked against the author's bank and the example bank.

`step-eeo-disability.html` and `step-checkbox-groups.html` (job J, 2026-11-15) and `step-consents.html` and `review-profile.html` (job H) were scrubbed on 2026-11-16, after the scrubber learned to blank a review page's "Edit <entry>" labels, and leak-checked against the author's bank and the example bank. The pages they duplicate (job J's steps 5, 7 and 9, job H's second review capture) are not kept, nor is job J's education step: its School list is covered by a synthetic page in the reader and fill tests.

- `step-eeo-disability.html`: the "Disability" radio group has no aria-label; each radio is labelled through `aria-labelledby` by its own `<strong>Disability</strong>` heading, and the question is the `<p>` above the group.
- `step-checkbox-groups.html`: three optional checkbox groups whose question is a `<p>` above a legend-less fieldset; the boxes have no aria-label or name, and each box's text is a `<p>` beside its empty `label[for]`.
- `step-consents.html`: two single "I consent" boxes in the same shape, the first required (its question ends in `*`).
- `review-profile.html`: a review page listing the author's work experience and education, whose Edit buttons are named after the entries; the scrubber blanked the entry names, and kept the section names.

`review-one-page.html` is a one-page form: its only primary button is "Submit application", while it still has contact and resume fields.

| file                          | kind        | source                                                          | scrubbed |
| ----------------------------- | ----------- | --------------------------------------------------------------- | -------- |
| job-page.html                 | job         | snapshot, 2026-11-12, job A job page                            | yes      |
| job-page-2.html               | job         | snapshot, 2026-11-12, job B job page                            | yes      |
| job-applied.html              | job-applied | snapshot, 2026-11-12, job C after submit                        | yes      |
| step-contact.html             | step        | snapshot, 2026-11-12, job D step 1                              | yes      |
| step-contact-email-phone.html | step        | snapshot, 2026-11-12, job A step 1                              | yes      |
| step-resume.html              | step        | snapshot, 2026-11-12, job A step 2                              | yes      |
| step-questions.html           | step        | snapshot, 2026-11-12, job B step 3                              | yes      |
| step-questions-2.html         | step        | snapshot, 2026-11-12, job A step 3                              | yes      |
| step-questions-location.html  | step        | snapshot, 2026-11-12, job D step 3                              | yes      |
| review-one-page.html          | review      | snapshot, 2026-11-12, job E review                              | yes      |
| review.html                   | review      | snapshot, 2026-11-12, job A review                              | yes      |
| review-save-prompt.html       | review      | snapshot, 2026-11-12, job B save prompt                         | yes      |
| review-backdrop-prompt.html   | step        | snapshot, 2026-11-12, job F step 1 with the save prompt over it | yes      |
| review-follow.html            | review      | snapshot, 2026-11-14, job G review                              | yes      |
| sent-dialog-2.html            | job-applied | snapshot, 2026-11-14, job G after submit, sent dialog open      | yes      |
| step-contact-city.html        | step        | snapshot, 2026-11-16, job H step 1                              | yes      |
| step-contact-de.html          | step        | snapshot, 2026-11-16, job I step 1 (German labels)              | yes      |
| step-eeo-disability.html      | step        | snapshot, 2026-11-15, job J step 4 (self identification)        | yes      |
| step-checkbox-groups.html     | step        | snapshot, 2026-11-15, job J step 8 (additional questions)       | yes      |
| step-consents.html            | step        | snapshot, 2026-11-16, job H step 5 (consents)                   | yes      |
| review-profile.html           | review      | snapshot, 2026-11-16, job H review                              | yes      |
