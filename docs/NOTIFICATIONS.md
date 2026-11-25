# Notifications

HypAware Cloud emails your organization when something happens: a report is
published, a host connects or goes quiet, someone joins. This page covers what
gets sent, who gets it, and how to turn it off. It's all set on the
**Notifications** page of the [HypAware Cloud dashboard](https://app.hypaware.ai/).

A host is any machine the collector runs on.

## What you get

**Reports.** When a report is published to your organization, every member
gets an email. That includes reports HypAware Cloud generates and reports a
member publishes from the CLI or their coding agent with
[`hyp report publish`](REPORTS.md#publish-a-report). The organization's first
report gets its own email. A report kept private to the member who made it is
never announced, not even to that member.

**Recommendations.** When a recommendation is published on its own, outside a
report, every member gets an email. That includes one a member publishes with
[`hyp recommendation publish`](CLI_REFERENCE.md#hyp-recommendation-publish).
A recommendation inside a report gets no email of its own.

**Your own hosts and invites.** You get an email when a host you set up first
connects, when none of your hosts has connected a day after you joined, when
you haven't signed in and your hosts haven't reported for two weeks, and when
someone you invited joins.

**Admin alerts.** Admins get an email when a new host first reports to the
organization, when a host that was reporting goes quiet, and when the
organization's model usage jumps well above its usual level.

**Always sent.** These can't be turned off: invitations, sign-in links, the
welcome email, the new-member notice to admins, and the notice to admins when
something they connected stops working.

Emails name your organization, report and recommendation titles, host names
and counts, and link to the dashboard. They never include session content,
prompts, responses, or report or recommendation text.

## Turn your own email on or off

Open **Notifications**, then **Your email**. Each switch shows whether you set
it yourself or are following the organization default. **Use default** puts it
back.

- Your choices apply to your email address in every organization you belong
  to.
- **Report emails** covers both reports and recommendations published on
  their own.
- Your choice wins over the organization's in both directions. If an admin has
  turned report email off, you can still turn it on for yourself, and the other
  way around.
- The unsubscribe link at the bottom of an email turns off that one kind of
  email, the same as flipping its switch.

## Set what the organization sends (admins)

Open **Notifications**, then **Org notifications**. Changes apply to everyone
in the organization.

- **Reports:** turn email for **First report**, **New reports** and **New
  recommendations** on or off.
  It's on by default. Members who set their own report email keep their
  choice.
- **Admin alerts:** turn **New host**, **Host stopped reporting** and **Usage
  spike** on or off for every admin. They're on by default.

## Questions

**I published a report and nobody got an email.** Check that it's public: a
private report is never announced. Then check **Org notifications**: an admin
may have turned report email off.

**I never get report emails.** Check **Your email** on the Notifications page.
If it says the organization doesn't email reports, ask an admin, or turn report
email on for yourself.

See also: [Reports](REPORTS.md), [Privacy controls](PRIVACY.md), and the
[privacy policy](https://hypaware.ai/privacy).
