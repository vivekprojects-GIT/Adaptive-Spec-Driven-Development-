/**
 * Templates.
 *
 * A template is a STARTING SHAPE, not a ready-made run: it sets the source and target stacks, says
 * what you need to provide, and shows the sort of requirements that belong here. It deliberately
 * carries no content of yours — you upload your own files and your own requirements, and the
 * interview holds the project until you have.
 *
 * Each template also carries an `example` for people who want to watch the pipeline work end to
 * end before feeding it real material. Loading it is a separate, explicitly-labelled action.
 */

const SELENIUM_LOGIN = `package com.acme.tests;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.testng.Assert;
import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

public class LoginTest {

  private WebDriver driver;

  @BeforeClass
  public void setUp() {
    driver = new ChromeDriver();
  }

  @Test
  public void userCanLogInWithValidCredentials() {
    driver.get("https://shop.example.com/login");
    driver.findElement(By.id("username")).sendKeys("standard_user");
    driver.findElement(By.id("password")).sendKeys("secret_sauce");
    driver.findElement(By.cssSelector("button[type='submit']")).click();
    Thread.sleep(2000);
    Assert.assertEquals(driver.getTitle(), "Products");
    Assert.assertTrue(driver.findElement(By.className("inventory_list")).isDisplayed());
  }

  @Test
  public void invalidPasswordShowsError() {
    driver.get("https://shop.example.com/login");
    driver.findElement(By.id("username")).sendKeys("standard_user");
    driver.findElement(By.id("password")).sendKeys("wrong_password");
    driver.findElement(By.cssSelector("button[type='submit']")).click();
    Assert.assertEquals(driver.findElement(By.cssSelector("[data-test='error']")).getText(),
        "Username and password do not match any user in this service");
  }

  @Test
  public void lockedOutUserIsRejected() {
    driver.get("https://shop.example.com/login");
    driver.findElement(By.id("username")).sendKeys("locked_out_user");
    driver.findElement(By.id("password")).sendKeys("secret_sauce");
    driver.findElement(By.xpath("//button[@type='submit']")).click();
    Assert.assertTrue(driver.findElement(By.cssSelector("[data-test='error']")).isDisplayed());
  }

  @AfterClass
  public void tearDown() {
    driver.quit();
  }
}
`;

const SELENIUM_CHECKOUT = `package com.acme.tests;

import org.openqa.selenium.By;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.support.ui.Select;
import org.testng.Assert;
import org.testng.annotations.Test;

public class CheckoutTest {

  private WebDriver driver;

  @Test
  public void userCanCompleteCheckout() {
    driver.get("https://shop.example.com/cart");
    driver.findElement(By.id("checkout")).click();
    driver.findElement(By.id("first-name")).sendKeys("Ada");
    driver.findElement(By.id("last-name")).sendKeys("Lovelace");
    driver.findElement(By.id("postal-code")).sendKeys("SW1A 1AA");
    new Select(driver.findElement(By.id("shipping"))).selectByVisibleText("Next day");
    driver.findElement(By.id("continue")).click();
    Assert.assertEquals(driver.findElement(By.className("summary_total_label")).getText(), "Total: $49.99");
  }

  @Test
  public void cartBadgeReflectsItemCount() {
    driver.get("https://shop.example.com/inventory");
    driver.findElement(By.cssSelector("[data-test='add-to-cart-backpack']")).click();
    ((JavascriptExecutor) driver).executeScript("window.scrollTo(0, document.body.scrollHeight)");
    Assert.assertEquals(driver.findElement(By.className("shopping_cart_badge")).getText(), "1");
  }
}
`;

const TEST_DATA_CSV = `username,password,role,expected
standard_user,secret_sauce,shopper,success
locked_out_user,secret_sauce,shopper,locked
problem_user,secret_sauce,shopper,degraded
performance_glitch_user,secret_sauce,shopper,slow
`;

const CYPRESS_SPEC = `describe('Account settings', () => {
  beforeEach(() => {
    cy.visit('/account/settings');
  });

  it('updates the display name', () => {
    cy.get('#display-name').clear();
    cy.get('#display-name').type('Ada Lovelace');
    cy.get('[data-cy=save]').click();
    cy.get('.toast').should('contain', 'Saved');
  });

  it('rejects an empty display name', () => {
    cy.get('#display-name').clear();
    cy.get('[data-cy=save]').click();
    cy.get('.field-error').should('be.visible');
  });

  it('changes the notification preference', () => {
    cy.get('#notifications').select('Weekly digest');
    cy.get('[data-cy=save]').click();
    cy.task('auditLog', 'preference changed');
    cy.get('.toast').should('contain', 'Saved');
  });
});
`;

const POSTMAN = JSON.stringify(
  {
    info: { name: 'Orders API (legacy)', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'List orders',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
          url: { raw: 'https://api.example.com/orders' },
        },
        event: [{ listen: 'test', script: { exec: ['pm.test("status is 200", function () { pm.response.to.have.status(200); });'] } }],
      },
      {
        name: 'Create order',
        request: {
          method: 'POST',
          header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
          url: { raw: 'https://api.example.com/orders' },
          body: { raw: '{"sku":"BACKPACK-1","qty":2}' },
        },
        event: [{ listen: 'test', script: { exec: ['pm.test("created", function () { pm.response.to.have.status(201); });'] } }],
      },
      {
        name: 'Get order by id',
        request: { method: 'GET', header: [], url: { raw: 'https://api.example.com/orders/42' } },
        event: [{ listen: 'test', script: { exec: ['pm.test("status is 200", function () { pm.response.to.have.status(200); });'] } }],
      },
    ],
  },
  null,
  2,
);

const JUNIT_SUITE = `package com.acme.pricing;

import org.junit.Test;
import static org.junit.Assert.*;

public class PriceCalculatorTest {

  @Test
  public void appliesPercentageDiscount() {
    PriceCalculator calculator = new PriceCalculator();
    assertEquals("44.99", calculator.apply(49.99, 10));
  }

  @Test
  public void rejectsNegativeDiscount() {
    PriceCalculator calculator = new PriceCalculator();
    assertFalse(calculator.isValidDiscount(-5));
  }

  @Test
  public void zeroDiscountReturnsListPrice() {
    PriceCalculator calculator = new PriceCalculator();
    assertEquals("49.99", calculator.apply(49.99, 0));
  }
}
`;

const COBOL = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ACCT-BALANCE-TEST.
       PROCEDURE DIVISION.
           MOVE 1000 TO WS-BALANCE
           PERFORM CHECK-BALANCE
           IF WS-RESULT NOT = 'PASS'
              DISPLAY 'TEST FAILED'
           END-IF.
`;

export const TEMPLATES = [
  {
    id: 'selenium-to-playwright',
    name: 'Selenium (Java) → Playwright (TypeScript)',
    headline: 'Bring your Java Selenium suite and its fixtures. Locators, actions and assertions are carried across; anything with no Playwright equivalent is surfaced rather than dropped.',
    starter: { projectKind: 'migration', sourceStack: 'Selenium WebDriver (Java) with TestNG', targetStack: 'Playwright (TypeScript)' },
    expects: [
      'Your Java test classes (.java) — the ones with @Test methods',
      'Any page objects that use @FindBy',
      'Fixture files your tests read (.csv, .json, .properties)',
      'Your requirements — typed in, or imported as a document',
    ],
    requirementHints: [
      'REQ-001 A shopper can log in with valid credentials',
      'REQ-002 An invalid password shows an inline error message',
    ],
    example: {
      requirements: [
        'REQ-001 A shopper can log in with valid credentials',
        'REQ-002 An invalid password shows an inline error message',
        'REQ-003 A locked out user is rejected with an error',
        'REQ-004 A shopper can complete checkout and see the order total',
        'REQ-005 The cart badge reflects the number of items added',
      ].join('\n'),
      constraints: 'Target must run headless in CI. No credentials in source control.',
      artifacts: [
        { path: 'src/test/java/com/acme/tests/LoginTest.java', content: SELENIUM_LOGIN },
        { path: 'src/test/java/com/acme/tests/CheckoutTest.java', content: SELENIUM_CHECKOUT },
        { path: 'src/test/resources/users.csv', content: TEST_DATA_CSV },
      ],
    },
  },
  {
    id: 'cypress-to-playwright',
    name: 'Cypress → Playwright (TypeScript)',
    headline: 'Bring your Cypress specs. The factory swaps in the Cypress analyzer and adds a command-mapping agent; cy.task and custom commands are flagged for a human.',
    starter: { projectKind: 'migration', sourceStack: 'Cypress', targetStack: 'Playwright (TypeScript)' },
    expects: [
      'Your Cypress spec files (.cy.js, .cy.ts or .spec.js)',
      'Fixtures your specs load with cy.fixture()',
      'Your requirements — typed in, or imported as a document',
    ],
    requirementHints: ['REQ-101 A user can update their display name'],
    example: {
      requirements: [
        'REQ-101 A user can update their display name',
        'REQ-102 An empty display name is rejected',
        'REQ-103 A user can change their notification preference',
      ].join('\n'),
      constraints: 'cy.task calls have no Playwright equivalent and must be surfaced.',
      artifacts: [{ path: 'cypress/e2e/account-settings.cy.js', content: CYPRESS_SPEC }],
    },
  },
  {
    id: 'rest-to-playwright-api',
    name: 'Legacy REST collection → Playwright API (TypeScript)',
    headline: 'Bring a Postman export, .http files or a RestAssured suite. Every pm.test check is parsed and re-emitted as real Playwright code; contract and auth become the guardrails that matter.',
    starter: { projectKind: 'migration', sourceStack: 'Legacy REST API tests (Postman collection)', targetStack: 'Playwright API testing (TypeScript)' },
    expects: [
      'Your collection export (.json), .http files, or RestAssured test classes',
      'Which auth scheme the suite uses, if any',
      'Your requirements — typed in, or imported as a document',
    ],
    requirementHints: ['REQ-201 The orders list endpoint returns 200 for an authenticated caller'],
    example: {
      requirements: [
        'REQ-201 The orders list endpoint returns 200 for an authenticated caller',
        'REQ-202 Creating an order returns 201',
        'REQ-203 A single order can be fetched by id',
      ].join('\n'),
      constraints: 'Bearer token must come from the environment.',
      artifacts: [{ path: 'collections/orders.postman_collection.json', content: POSTMAN }],
    },
  },
  {
    id: 'junit-to-pytest',
    name: 'JUnit → PyTest',
    headline: 'A language change rather than a framework change — same control plane, different emitter. Bring your JUnit classes.',
    starter: { projectKind: 'migration', sourceStack: 'JUnit', targetStack: 'PyTest' },
    expects: ['Your JUnit test classes (.java)', 'Your requirements — typed in, or imported as a document'],
    requirementHints: ['REQ-301 A percentage discount is applied to the list price'],
    example: {
      requirements: [
        'REQ-301 A percentage discount is applied to the list price',
        'REQ-302 Negative discounts are rejected',
        'REQ-303 A zero discount returns the list price',
      ].join('\n'),
      constraints: '',
      artifacts: [{ path: 'src/test/java/com/acme/pricing/PriceCalculatorTest.java', content: JUNIT_SUITE }],
    },
  },
  {
    id: 'custom',
    name: 'Custom project — you author the agents',
    headline: 'No framework assumptions at all. Bring your requirements and whatever source material you have; the platform asks what you want produced and you author the agents that produce it.',
    starter: { projectKind: 'custom', sourceStack: '', targetStack: '' },
    expects: [
      'Your requirements — typed in, or imported as a document',
      'Any source material the agents should read (any file type)',
      'A clear statement of what you want produced',
    ],
    requirementHints: ['Produce an onboarding checklist for the payments service'],
    example: null,
  },
  {
    id: 'gap-demo',
    name: 'Unsupported stack (honest-failure demo)',
    headline: 'Deliberately unsupported. Shows the platform raising a Capability Gap — what is missing and what would have to be built — instead of pretending it can migrate.',
    starter: { projectKind: 'migration', sourceStack: 'Mainframe COBOL batch test harness', targetStack: 'Playwright (TypeScript)' },
    expects: ['Nothing — this template exists to show the refusal path'],
    requirementHints: ['REQ-401 Account balance calculation is verified end to end'],
    example: {
      requirements: 'REQ-401 Account balance calculation is verified end to end',
      constraints: '',
      artifacts: [{ path: 'jcl/ACCTBAL.cbl', content: COBOL }],
    },
  },
];

export function findTemplate(templateId) {
  return TEMPLATES.find((template) => template.id === templateId) || null;
}

/** The spec a template starts you with: stacks set, YOUR content still to come. */
export function starterSpec(templateId) {
  const template = findTemplate(templateId);
  if (!template) return null;
  return {
    ...template.starter,
    requirements: '',
    constraints: '',
    artifacts: [],
    clarifications: {},
    templateId: template.id,
    requirementHints: template.requirementHints,
    expects: template.expects,
  };
}

/** The same template pre-filled with demo content, for watching the pipeline work. */
export function exampleSpec(templateId) {
  const template = findTemplate(templateId);
  if (!template?.example) return null;
  return {
    ...starterSpec(templateId),
    requirements: template.example.requirements,
    constraints: template.example.constraints,
    artifacts: template.example.artifacts,
    isExample: true,
  };
}
