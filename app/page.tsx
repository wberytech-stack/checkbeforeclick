import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import styles from "./welcome.module.css";

export const metadata: Metadata = {
  title: "CheckBeforeClick | Know the risk before the click",
  description: "Investigate suspicious links with clear verdicts and evidence-backed security intelligence.",
};

// Keep destination changes explicit when adapting this candidate to another release surface.
const destinations = { home: "/", check: "/scan/new", history: "/history", account: "/login" };

function LensMark() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 3a17 17 0 0 1 17 17M20 37A17 17 0 0 1 3 20" stroke="currentColor" strokeWidth="2" /><path d="M8 8h12v12H8zM20 20h12v12H20z" stroke="currentColor" strokeWidth="1.4" /><path d="m14 20 4 4 9-10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export default function AzureWelcomePage() {
  return <>
    <div className={styles.page}>
      <a href="#main" className={styles.skip}>Skip to main content</a>
      <header className={styles.header}>
        <Link prefetch={false} href={destinations.home} className={styles.brand} aria-label="CheckBeforeClick home"><LensMark /><span>checkbeforeclick<span className={styles.brandPeriod}>.</span></span></Link>
        <nav aria-label="Main navigation" className={styles.navigation}>
          <a className={styles.sectionLink} href="#the-experience">The experience</a>
          <a className={styles.sectionLink} href="#inside-a-verdict">Inside a verdict</a>
          <Link prefetch={false} className={styles.accountLink} href={destinations.account}>Your workspace <span aria-hidden="true">↗</span></Link>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}><span className={styles.star} aria-hidden="true">✳</span> A MOMENT OF CLARITY</p>
            <h1 id="hero-title">Look closer.<br /><em>Click wiser.</em></h1>
            <p className={styles.lead}>The internet asks for your trust.<br />Take a moment to understand what’s behind a suspicious link before you give it.</p>
            <div className={styles.actions}><Link prefetch={false} className={styles.primaryAction} href={destinations.check}>Check a link <span aria-hidden="true">↗</span></Link><a className={styles.textAction} href="#inside-a-verdict">See a considered decision <span aria-hidden="true">↓</span></a></div>
            <p className={styles.signInNote}>Sign in is required to submit a check and view your history.</p>
            <div className={styles.heroNote}><span aria-hidden="true" /><p>Not a promise of perfect safety.<br /><strong>A better basis for your next decision.</strong></p></div>
          </div>
          <figure className={styles.artwork}>
            <div className={styles.artRegistration} aria-hidden="true"><span>FIG. 01</span><span>A CHANGE IN PERSPECTIVE</span></div>
            <div className={styles.artCanvas}><Image src="/decision-lens-v3.png" width={1300} height={1209} sizes="(max-width: 760px) 100vw, (max-width: 1440px) 48vw, 640px" preload alt="" className={styles.lensImage} /></div>
            <figcaption className={styles.artCaption}><span aria-hidden="true">↳</span><p>From a link you see.<br /><em>To a risk you understand.</em></p></figcaption>
            <details className={styles.lensExplanation}><summary>Why a lens?<span aria-hidden="true">+</span></summary><p>The lens is a visual metaphor for taking a closer look. CBC brings available signals into focus so you can decide with more context. The artwork is not a scan, a security score, or a promise of safety.</p></details>
          </figure>
        </section>
        <section className={styles.principles} aria-label="Our approach"><p>The point isn’t to click faster.<br /><em>It’s to see more clearly.</em></p><ol><li><span>01</span>Evidence before reassurance</li><li><span>02</span>Context before confidence</li><li><span>03</span>Clarity before action</li></ol></section>
        <section className={styles.verdictSection} id="inside-a-verdict" aria-labelledby="verdict-title">
          <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>INSIDE A VERDICT / 01</p><h2 id="verdict-title">A verdict is a beginning.<br /><em>Understanding is the point.</em></h2></div><p>A useful result connects the concern,<br />the available evidence, and your next step.</p></div>
          <article className={styles.caseStudy} aria-label="Illustrative investigation, not a live scan">
            <header className={styles.caseHeader}><span>ILLUSTRATIVE EXAMPLE</span><p>Not a live scan. No check has been performed.</p></header>
            <div className={styles.caseBody}>
              <div className={styles.decision}><p className={styles.caseLabel}>01 / THE DECISION</p><p className={styles.caution}><span aria-hidden="true">!</span> CAUTION</p><h3>Pause.<br />This deserves<br /><em>a closer look.</em></h3><div className={styles.confidence}><span>Confidence in this example</span><strong>Moderate</strong><p>Limited corroborating evidence.</p></div><div className={styles.sampleUrl}><span>THE EXAMPLE LINK</span><code>northstar.account-review.example</code></div></div>
              <div className={styles.reason}><p className={styles.caseLabel}>02 / WHY IT MATTERS</p><h3>A familiar name.<br />An unverified connection.</h3><p>In this fictional example, a message claims to be from Northstar. But “northstar” is a subdomain of “account-review.example”. The familiar name does not verify a connection to the claimed service.</p><details className={styles.evidence}><summary>Look at the signals<span aria-hidden="true">+</span></summary><dl><div><dt>Unverified identity</dt><dd>A familiar name in a subdomain does not establish who controls the destination.</dd></div><div><dt>Incomplete evidence</dt><dd>There is not enough corroboration for an all-clear. Domain structure alone is not a verdict.</dd></div></dl></details><div className={styles.nextStep}><p className={styles.caseLabel}>03 / YOUR NEXT MOVE</p><p>Go to the service using its known address or a saved bookmark. Verify the request there.</p></div></div>
            </div>
            <p className={styles.caseLimit}>A verdict is guidance, not a guarantee of safety. An unclear or failed check is never a safety clearance.</p>
          </article>
        </section>
        <section className={styles.experience} id="the-experience" aria-labelledby="experience-title">
          <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>THE EXPERIENCE / 02</p><h2 id="experience-title">Intelligence that meets you<br /><em>where the doubt begins.</em></h2></div></div>
          <ol className={styles.steps}><li><span>01 / BRING THE QUESTION</span><h3>That message.<br />That request.<br />That uneasy feeling.</h3><p>Start with the URL you want to understand. You don’t need to visit the destination to submit it for a check.</p><Link prefetch={false} href={destinations.check}>Start an investigation <span aria-hidden="true">↗</span></Link></li><li><span>02 / SEE WHAT’S KNOWN</span><h3>The signals.<br />The explanation.<br />The missing pieces.</h3><p>Review the available findings. Uncertainty should stay visible; incomplete evidence should never become false reassurance.</p><a href="#inside-a-verdict">Explore the example <span aria-hidden="true">↗</span></a></li><li><span>03 / CHOOSE YOUR NEXT STEP</span><h3>Less guesswork.<br />A practical action.<br />A considered click.</h3><p>Use the recommendation, verify through a trusted channel, and revisit your recent checks in your workspace.</p><Link prefetch={false} href={destinations.history}>View your history <span aria-hidden="true">↗</span></Link></li></ol>
        </section>
        <section className={styles.closing} aria-labelledby="closing-title"><LensMark /><p className={styles.eyebrow}>THE SMALL PAUSE BEFORE THE NEXT MOVE</p><h2 id="closing-title">A link is a possibility.<br /><em>Trust is a decision.</em></h2><Link prefetch={false} className={styles.primaryAction} href={destinations.check}>Make an informed one <span aria-hidden="true">↗</span></Link><p>CheckBeforeClick. A moment of clarity.</p></section>
      </main>
      <nav aria-label="Homepage footer" className={styles.footer}><Link prefetch={false} href={destinations.home} className={styles.footerBrand}><LensMark />checkbeforeclick.</Link><span>A product of Wabcan Inc.</span><Link prefetch={false} href={destinations.account}>Your workspace <span aria-hidden="true">↗</span></Link></nav>
    </div>
  </>;
}
