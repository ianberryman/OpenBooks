package org.openbooks.openbooksapi.core.model;


import java.util.List;

public interface AccountingEntry {

    Long getId();

    void setId(Long id);

    boolean isBalanced();

    public List<Transaction> getTransactionList();

    public void setTransactionList(List<Transaction> transactionList);

    public void addTransaction(Transaction transaction);
}
