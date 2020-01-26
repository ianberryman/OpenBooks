package org.openbooks.openbooksapi.core.model;

/**
 * Represents the two options available for accounting
 * adjustments.
 *
 * Credits increase liability or equity accounts and
 * decrease asset or expense accounts.
 *
 * Debits increase asset or expense accounts and
 * decrease liability or equity accounts.
 */
public enum TransactionType {
    CREDIT, DEBIT;
}
