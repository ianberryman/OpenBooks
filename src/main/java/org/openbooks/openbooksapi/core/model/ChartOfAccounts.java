package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.repository.AccountRepository;

import java.util.List;

public interface ChartOfAccounts {

	public AccountRepository getAccountsRepository();
	
	public List<Account> getAccounts();
	
	public Account getAccountById(Long id);
	
	public List<Account> getAccountsByAccountNumber(String accountNumber);
	
	public void createAccount(Account account);
	
	public void deleteAccount(Long id);
}
