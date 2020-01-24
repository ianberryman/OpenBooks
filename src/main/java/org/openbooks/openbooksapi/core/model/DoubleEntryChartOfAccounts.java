package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.repository.AccountRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.EmptyResultDataAccessException;

import java.util.List;
import java.util.NoSuchElementException;

public class DoubleEntryChartOfAccounts implements ChartOfAccounts {

	@Autowired
	private AccountRepository accountRepo;
	
	@Override
	public AccountRepository getAccountsRepository() {
		return accountRepo;
	}

	@Override
	public List<Account> getAccounts() {
		return accountRepo.findAll();
	}

	@Override
	public Account getAccountById(Long id) {
		return accountRepo.findById(id).get();
	}
	
	@Override
	public List<Account> getAccountsByAccountNumber(String accountNumber) {
		return accountRepo.findByAccountNumber(accountNumber);
	}

	@Override
	public void createAccount(Account account) {
		accountRepo.save(account);
	}

	@Override
	public void deleteAccount(Long id) {
		try {
			accountRepo.deleteById(id);
		// remap error to ensure consistency
		} catch (EmptyResultDataAccessException e) {
			throw new NoSuchElementException("Account with ID " + id + " not found");
		}
	}
	
	
}
