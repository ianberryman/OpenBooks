package org.openbooks.openbooksapi;

import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.openbooks.openbooksapi.core.controller.AccountController;
import org.openbooks.openbooksapi.core.controller.AccountingEntryController;
import org.openbooks.openbooksapi.core.controller.CompanyController;
import org.openbooks.openbooksapi.core.controller.TransactionController;
import org.openbooks.openbooksapi.core.error.UnbalancedAccountingEntryException;
import org.openbooks.openbooksapi.core.model.*;
import org.openbooks.openbooksapi.core.repository.DoubleEntryAccountingEntryRepository;
import org.openbooks.openbooksapi.core.repository.TransactionRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

import static org.hamcrest.Matchers.greaterThan;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ApplicationContextTests {

    @Autowired
    AccountController accountController;
    @Autowired
    AccountingEntryController entryController;
    @Autowired
    CompanyController companyController;
    @Autowired
    TransactionController transactionController;

    @Autowired
    JournalService<DoubleEntryAccountingEntry> journalService;

    /**
     * Test that all necessary controllers loaded
     * @throws Exception
     */
	@Test
    public void contextLoads() throws Exception {
	    assertAll("Check that controllers loaded" ,() -> {
            assertNotNull(accountController);
            assertNotNull(entryController);
            assertNotNull(companyController);
            assertNotNull(transactionController);
        });
    }

    /**
     * AccountController tests
     */
    @Autowired
    MockMvc mockMvc;

    @Test
    void AccountConroller_getAccounts_ReturnsValidResponse() throws Exception {
        this.mockMvc.perform(get("/accounts"))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.length()", greaterThan(0)));
    }


    /**
     * DoubleEntryJournalService tests
     */
    @Test
    void commitAccountingEntry_UnbalancedEntry_ThrowsException() {
        DoubleEntryAccountingEntry entry = new DoubleEntryAccountingEntry();
        Transaction t1 = new Transaction(new BigDecimal("152.36"), TransactionType.CREDIT);
        t1.accountId = 1L;
        Transaction t2 = new Transaction(new BigDecimal("15.23"), TransactionType.DEBIT);
        t2.accountId = 2L;
        entry.addTransaction(t1);
        entry.addTransaction(t2);

        assertThrows(UnbalancedAccountingEntryException.class,
                () -> journalService.commitAccountingEntry(entry));
    }

    @Test
    void commitAccountingEntry_BalancedEntry_Successful() {
        DoubleEntryAccountingEntry entry = new DoubleEntryAccountingEntry();
        Transaction t1 = new Transaction(new BigDecimal("10123.36"), TransactionType.CREDIT);
        t1.accountId = 1L;
        Transaction t2 = new Transaction(new BigDecimal("10123.36"), TransactionType.DEBIT);
        t2.accountId = 2L;
        entry.addTransaction(t1);
        entry.addTransaction(t2);

        assertDoesNotThrow(() -> journalService.commitAccountingEntry(entry));
    }

    @Test
    void updateAccountingEntry_UnbalancedEntry_ThrowsException() {
        DoubleEntryAccountingEntry entry = new DoubleEntryAccountingEntry();
        entry.setId(2L);
        Transaction t1 = new Transaction(new BigDecimal("152.36"), TransactionType.CREDIT);
        t1.accountId = 1L;
        Transaction t2 = new Transaction(new BigDecimal("15.23"), TransactionType.DEBIT);
        t2.accountId = 2L;
        entry.addTransaction(t1);
        entry.addTransaction(t2);

        assertThrows(UnbalancedAccountingEntryException.class,
                () -> journalService.updateAccountingEntry(entry));
    }

    @Test
    void updateAccountingEntry_BalancedEntry_Successful() {
        DoubleEntryAccountingEntry entry = new DoubleEntryAccountingEntry();
        entry.setId(1L);
        Transaction t1 = journalService.getTransactionById(1L).get();
        t1.setAmount(new BigDecimal("10523.36"));
        t1.accountId = t1.getAccountId();
        Transaction t2 = journalService.getTransactionById(2L).get();
        t2.setAmount(new BigDecimal("10523.36"));
        t2.accountId = t2.getAccountId();
        entry.addTransaction(t1);
        entry.addTransaction(t2);

        assertDoesNotThrow(() -> journalService.updateAccountingEntry(entry));
    }
}
