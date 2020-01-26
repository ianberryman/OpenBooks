package org.openbooks.openbooksapi.core.model;


import javax.persistence.Entity;
import javax.persistence.Inheritance;
import javax.persistence.InheritanceType;
import java.util.List;

public interface AccountingEntry {

    Long getId();

    void setId(Long id);

    boolean isBalanced();

    public List<Transaction> getTransactionList();

    public void setTransactionList(List<Transaction> transactionList);

    public void addTransaction(Transaction transaction);
}
