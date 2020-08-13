package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.error.UnbalancedAccountingEntryException;

import java.util.List;
import java.util.Optional;

public interface JournalService<E extends AccountingEntry> {

    E commitAccountingEntry(E entry) throws UnbalancedAccountingEntryException;

    E updateAccountingEntry(E entry) throws UnbalancedAccountingEntryException;

    List<E> getAccountingEntries();

    Optional<E> getAccountingEntryById(Long entryId);

    List<Transaction> getTransactionsForAccount(Account account);

    Optional<Transaction> getTransactionById(Long id);
}

