package org.openbooks.openbooksapi;


import org.junit.jupiter.api.Test;
import org.openbooks.openbooksapi.core.model.Account;
import org.openbooks.openbooksapi.core.model.DoubleEntryAccountingEntry;
import org.openbooks.openbooksapi.core.model.Transaction;
import org.openbooks.openbooksapi.core.model.TransactionType;
import org.openbooks.openbooksapi.core.repository.DoubleEntryAccountingEntryRepository;
import org.springframework.boot.test.mock.mockito.MockBean;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

public class DoubleEntryAccountingEntryTests {

    @Test
    void isBalanced_OneTran_False() {
        List<Transaction> transactionList = new ArrayList<>();
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(1.05), TransactionType.CREDIT));
        DoubleEntryAccountingEntry entry = new DoubleEntryAccountingEntry();
        entry.setTransactionList(transactionList);

        assertFalse(entry.isBalanced());
    }

    @Test
    void isBalanced_TwoUnbalancedTrans_False() {
        List<Transaction> transactionList = new ArrayList<>();
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                            BigDecimal.valueOf(1.05), TransactionType.CREDIT));
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(1.05), TransactionType.CREDIT));
        DoubleEntryAccountingEntry entry = new DoubleEntryAccountingEntry();
        entry.setTransactionList(transactionList);

        assertFalse(entry.isBalanced());
    }

    @Test
    void isBalanced_ThreeUnbalancedTrans_False() {
        List<Transaction> transactionList = new ArrayList<>();
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(1.05), TransactionType.CREDIT));
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(1.05), TransactionType.CREDIT));
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(1.05), TransactionType.DEBIT));
        DoubleEntryAccountingEntry entry = new DoubleEntryAccountingEntry();
        entry.setTransactionList(transactionList);

        assertFalse(entry.isBalanced());
    }

    @Test
    void isBalanced_TwoBalancedTrans_True() {
        List<Transaction> transactionList = new ArrayList<>();
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(1.05), TransactionType.CREDIT));
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(1.05), TransactionType.DEBIT));
        DoubleEntryAccountingEntry entry = new DoubleEntryAccountingEntry();
        entry.setTransactionList(transactionList);

        assertTrue(entry.isBalanced());
    }

    @Test
    void isBalanced_ThreeBalancedTrans_True() {
        List<Transaction> transactionList = new ArrayList<>();
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(10.00), TransactionType.CREDIT));
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(5.00), TransactionType.DEBIT));
        transactionList.add(new Transaction(new Account(), new DoubleEntryAccountingEntry(),
                BigDecimal.valueOf(5.00), TransactionType.DEBIT));
        DoubleEntryAccountingEntry entry = new DoubleEntryAccountingEntry();
        entry.setTransactionList(transactionList);

        assertTrue(entry.isBalanced());
    }
}
